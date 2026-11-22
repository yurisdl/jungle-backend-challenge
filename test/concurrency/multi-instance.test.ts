import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { QueueUrls } from '../../src/infrastructure/sqs/sqs';
import {
  assertGlobalConsistency,
  createWallet,
  diedAbruptly,
  type Instance,
  queueEnv,
  sendMessage,
  spawnInstance,
  sql,
  submit,
  testQueues,
  waitFor,
  wagerMessage,
  walletState,
  type WagerInput,
} from '../support/harness';

const env = { ...queueEnv('multi'), DB_POOL_MAX: '15', SQS_CONCURRENCY: '10' };
let sqs: SQSClient;
let urls: QueueUrls;
const instances: Instance[] = [];

beforeAll(async () => {
  ({ sqs, urls } = await testQueues(env));
});
afterAll(async () => {
  await Promise.all(instances.map((i) => i.kill('SIGKILL')));
  await assertGlobalConsistency();
});

async function start(name: string, extra: Record<string, string> = {}) {
  const instance = await spawnInstance(name, { ...env, ...extra });
  instances.push(instance);
  return instance;
}

async function queueDepth(url: string): Promise<number> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(out.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

async function waitDrained(walletIds: string[], timeoutMs = 60_000) {
  await waitFor(
    async () => {
      if ((await queueDepth(urls.wager)) > 0) return false;
      const [row] = await sql<{ pending: number }>(
        `select count(*)::int as pending from outbox_messages where published_at is null and aggregate_id in (${walletIds.map(() => '?').join(',')})`,
        walletIds,
      );
      return row!.pending === 0;
    },
    { label: 'queue and outbox drained', timeoutMs, intervalMs: 300 },
  );
}

async function metric(instance: Instance, name: string): Promise<number> {
  const text = await (await fetch(`${instance.baseUrl}/metrics`)).text();
  return text
    .split('\n')
    .filter((l) => l.startsWith(name))
    .reduce((sum, l) => sum + Number(l.split(' ').pop()), 0);
}

describe('multiple instances (separate OS processes)', () => {
  let a: Instance;
  let b: Instance;
  let c: Instance;

  beforeAll(async () => {
    [a, b, c] = await Promise.all([start('instance-a'), start('instance-b'), start('instance-c')]);
  }, 60_000);

  test('three instances hammering the same wallets via HTTP and SQS keep every invariant', async () => {
    const all = [a, b, c];
    const wallets = await Promise.all(Array.from({ length: 4 }, () => createWallet(a.baseUrl, '100.00')));
    const operations: WagerInput[] = [];
    for (const w of wallets) {
      for (let i = 0; i < 60; i++) {
        operations.push({ wallet: w, kind: i % 5 === 0 ? 'WIN' : 'BET', amount: i % 5 === 0 ? '3.00' : '2.00', externalTransactionId: `m-${randomUUID()}` });
      }
    }
    // every operation is delivered 3 times: twice over HTTP (different instances), once over SQS
    // with a random message group, so SQS ordering does not serialise the wallet for us.
    await Promise.all(
      operations.flatMap((op, i) => [
        submit(all[i % 3]!.baseUrl, op),
        submit(all[(i + 1) % 3]!.baseUrl, op),
        sendMessage(sqs, urls.wager, wagerMessage(op), { groupId: randomUUID() }),
      ]),
    );
    await waitDrained(wallets.map((w) => w.id));

    for (const w of wallets) {
      const state = await walletState(w.id);
      const external = state.transactions.filter((t) => t.kind !== 'OPENING');
      // exactly one row per external transaction — no duplicate credit or debit
      expect(external).toHaveLength(60);
      expect(new Set(external.map((t) => t.external_transaction_id)).size).toBe(60);
      const processed = external.filter((t) => t.status === 'PROCESSED');
      const wins = processed.filter((t) => t.kind === 'WIN').length;
      const bets = processed.filter((t) => t.kind === 'BET').length;
      expect(state.entries).toHaveLength(1 + processed.length);
      expect(Number(state.wallet.balance)).toBeCloseTo(100 + wins * 3 - bets * 2, 2);
      expect(Number(state.wallet.balance)).toBeGreaterThanOrEqual(0);
      expect(external.filter((t) => t.status === 'REJECTED').every((t) => t.failure_code === 'INSUFFICIENT_FUNDS')).toBe(true);
    }
    // all three instances did real work
    for (const i of all) expect(await metric(i, 'wager_processing_duration_seconds_count')).toBeGreaterThan(0);
  }, 120_000);

  test('REFUND delivered (to one instance) before its BET (to another) is applied once the BET lands', async () => {
    const w = await createWallet(b.baseUrl, '100.00');
    const betId = `bet-${randomUUID()}`;
    const refund = await submit(a.baseUrl, { wallet: w, kind: 'REFUND', amount: '30.00', reference: betId });
    expect(refund.status).toBe(202);
    await sendMessage(sqs, urls.wager, wagerMessage({ wallet: w, kind: 'BET', amount: '30.00', externalTransactionId: betId }));
    await waitFor(
      async () => (await walletState(w.id)).transactions.find((t) => t.kind === 'REFUND')?.status === 'PROCESSED',
      { label: 'refund applied', timeoutMs: 20_000 },
    );
    const state = await walletState(w.id);
    expect(state.wallet.balance).toBe('100.00');
    expect(state.entries.map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
  }, 30_000);

  test('worker killed after the commit and before the ack: redelivery does not duplicate the debit', async () => {
    const api = await start('instance-api', { APP_ROLES: 'api' });
    // stop the other consumers so the crashing one is guaranteed to take the message
    await Promise.all([a, b, c].map((i) => i.kill('SIGTERM')));
    const crashing = await start('instance-crash', { APP_ROLES: 'consumer', FAULT_INJECTION: 'crash-after-commit' });
    const w = await createWallet(api.baseUrl, '100.00');
    const msg = wagerMessage({ wallet: w, kind: 'BET', amount: '40.00', externalTransactionId: `crash-${randomUUID()}` });
    await sendMessage(sqs, urls.wager, msg);

    await crashing.proc.exited;
    expect(diedAbruptly(crashing.proc)).toBe(true);
    // committed: debit + inbox are there, but the message was never deleted
    let state = await walletState(w.id);
    expect(state.wallet.balance).toBe('60.00');
    expect(await sql(`select 1 from inbox_messages where message_id = ? and processed_at is not null`, [msg.messageId])).toHaveLength(1);
    expect(await queueDepth(urls.wager)).toBe(1);

    // a healthy instance takes over after the visibility timeout
    const healthy = await start('instance-healthy');
    await waitFor(async () => (await queueDepth(urls.wager)) === 0, { label: 'redelivered and acked', timeoutMs: 30_000 });
    state = await walletState(w.id);
    expect(state.wallet.balance).toBe('60.00');
    expect(state.entries.filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    expect(await metric(healthy, 'wager_duplicates_total{source="sqs",type="inbox"}')).toBe(1);
  }, 90_000);

  test('restart under load (SIGKILL + SIGTERM): the system converges to a consistent state', async () => {
    const x = await start('instance-x');
    const y = await start('instance-y');
    const z = await start('instance-z');
    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet(x.baseUrl, '200.00')));
    const sent: string[] = [];
    const sendBatch = async (n: number) => {
      await Promise.all(
        Array.from({ length: n }, (_, i) => {
          const w = wallets[i % wallets.length]!;
          const ext = `r-${randomUUID()}`;
          sent.push(ext);
          return sendMessage(sqs, urls.wager, wagerMessage({ wallet: w, kind: 'BET', amount: '1.00', externalTransactionId: ext }));
        }),
      );
    };
    await sendBatch(150);
    await new Promise((r) => setTimeout(r, 400));
    await y.kill('SIGKILL'); // abrupt death: in-flight messages come back after the visibility timeout
    const graceful = z.kill('SIGTERM'); // graceful: finishes in-flight work, releases the rest
    await sendBatch(150);
    const gracefulExit = await graceful;
    // Windows has no SIGTERM: z dies abruptly there too, and convergence is still checked below
    if (process.platform !== 'win32') expect(gracefulExit).toBe(0);

    await start('instance-y2');
    await start('instance-z2');
    await waitDrained(wallets.map((w) => w.id), 90_000);

    const rows = await sql<{ external_transaction_id: string; status: string }>(
      `select external_transaction_id, status from wager_transactions where external_transaction_id in (${sent.map(() => '?').join(',')})`,
      sent,
    );
    expect(rows).toHaveLength(300);
    expect(rows.every((r) => r.status === 'PROCESSED')).toBe(true);
    for (const w of wallets) {
      const state = await walletState(w.id);
      expect(state.wallet).toEqual({ balance: '150.00', version: 51 });
      const res = await fetch(`${x.baseUrl}/wallets/${w.id}/reconciliation`, { method: 'POST' });
      expect(((await res.json()) as any).consistent).toBe(true);
    }
  }, 180_000);
});
