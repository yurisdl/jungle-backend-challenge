import type { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { QueueUrls } from '../../src/infrastructure/sqs/sqs';
import {
  assertGlobalConsistency,
  createWallet,
  drain,
  type Instance,
  queueEnv,
  sendMessage,
  spawnInstance,
  sql,
  submit,
  testQueues,
  waitFor,
  wagerMessage,
  type WagerInput,
  type WalletInfo,
} from '../support/harness';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

/**
 * "PostgreSQL e SQS podem ficar temporariamente indisponíveis."
 *
 * These tests break the real infrastructure containers while real instances
 * (separate processes) are under load, then prove that nothing was lost,
 * nothing was applied twice, and every invariant holds after recovery.
 */
/**
 * Opt-in: they stop shared containers, so a plain `bun test` skips them.
 * Run with `bun run test:resilience` (sets RESILIENCE_TESTS=1). CI runs them.
 */
const ENABLED = process.env.RESILIENCE_TESTS === '1';
const POSTGRES = process.env.POSTGRES_CONTAINER ?? 'wagering-processor-postgres-1';
const LOCALSTACK = process.env.LOCALSTACK_CONTAINER ?? 'wagering-processor-localstack-1';

const env = {
  ...queueEnv('outage'),
  DB_STATEMENT_TIMEOUT_MS: '2000',
  DB_CONNECT_TIMEOUT_MS: '1500',
  DB_ACQUIRE_TIMEOUT_MS: '3000',
  SQS_REQUEST_TIMEOUT_MS: '2000',
  SQS_MAX_RECEIVE_COUNT: '15',
};
let sqs: SQSClient;
let urls: QueueUrls;
const instances: Instance[] = [];

function docker(...args: string[]) {
  const out = Bun.spawnSync(['docker', ...args]);
  if (out.exitCode !== 0) throw new Error(`docker ${args.join(' ')}: ${out.stderr.toString()}`);
}

async function postgresReady() {
  await waitFor(
    async () => {
      try {
        await sql('select 1');
        return true;
      } catch {
        return false;
      }
    },
    { label: 'postgres back', timeoutMs: 60_000, intervalMs: 500 },
  );
}

async function queueDepth(url: string) {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(out.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

/** A provider client: retries only what the API says is retryable (503), with the same key. */
async function submitLikeAProvider(baseUrls: string[], op: WagerInput, statuses: number[]) {
  for (let attempt = 0; ; attempt++) {
    let status: number;
    try {
      status = (await submit(baseUrls[attempt % baseUrls.length]!, op)).status;
    } catch {
      status = 0; // connection-level failure: also retryable
    }
    statuses.push(status);
    if (status !== 503 && status !== 0) return status;
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  if (!ENABLED) return;
  ({ sqs, urls } = await testQueues(env));
  instances.push(await spawnInstance('outage-a', env), await spawnInstance('outage-b', env));
}, 60_000);

afterAll(async () => {
  if (!ENABLED) return;
  // never leave the shared infrastructure broken for the next test file
  Bun.spawnSync(['docker', 'unpause', LOCALSTACK]);
  Bun.spawnSync(['docker', 'start', POSTGRES]);
  await postgresReady();
  await Promise.all(instances.map((i) => i.kill('SIGKILL')));
  await assertGlobalConsistency();
}, 90_000);

describe.skipIf(!ENABLED)('infrastructure outages under load', () => {
  test('PostgreSQL crashes mid-load: API answers 503 (never 500), nothing is lost or duplicated', async () => {
    const bases = instances.map((i) => i.baseUrl);
    const wallets: WalletInfo[] = await Promise.all(Array.from({ length: 4 }, () => createWallet(bases[0]!, '100.00')));
    const ops: WagerInput[] = wallets.flatMap((w) =>
      Array.from({ length: 15 }, () => ({ wallet: w, kind: 'BET', amount: '1.00', externalTransactionId: `pg-${randomUUID()}` })),
    );
    const viaQueue = ops.filter((_, i) => i % 2 === 0);
    const viaHttp = ops.filter((_, i) => i % 2 === 1);

    for (const op of viaQueue) await sendMessage(sqs, urls.wager, wagerMessage(op));
    const statuses: number[] = [];
    const http = (async () => {
      const results: Promise<number>[] = [];
      for (const op of viaHttp) {
        results.push(submitLikeAProvider(bases, op, statuses));
        await new Promise((r) => setTimeout(r, 150));
      }
      return Promise.all(results);
    })();

    await new Promise((r) => setTimeout(r, 400));
    docker('kill', POSTGRES); // abrupt crash, no clean shutdown
    await new Promise((r) => setTimeout(r, 2_500));
    const ready = await fetch(`${bases[0]}/health/ready`);
    expect(ready.status).toBe(503);
    expect(((await ready.json()) as any).checks.postgres).toBe('down');
    expect((await fetch(`${bases[0]}/health/live`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2_500));
    docker('start', POSTGRES);
    await postgresReady();

    const finals = await http;
    expect(finals.every((s) => s === 201 || s === 200)).toBe(true);
    expect(statuses).toContain(503); // the outage was observed by clients…
    expect(statuses).not.toContain(500); // …and always as a retryable error

    await waitFor(async () => (await queueDepth(urls.wager)) === 0, { label: 'queue drained', timeoutMs: 60_000, intervalMs: 500 });
    const ids = ops.map((o) => o.externalTransactionId!);
    const rows = await sql<{ status: string }>(
      `select status from wager_transactions where external_transaction_id in (${ids.map(() => '?').join(',')})`,
      ids,
    );
    expect(rows).toHaveLength(ops.length); // one row per operation: nothing lost, nothing duplicated
    expect(rows.every((r) => r.status === 'PROCESSED')).toBe(true);
    for (const w of wallets) {
      const [state] = await sql<{ balance: string; version: number }>(
        `select balance_amount::text as balance, version from wallets where id = ?`,
        [w.id],
      );
      expect(state).toEqual({ balance: '85.00', version: 16 });
    }
    expect(await drain(sqs, urls.wagerDlq, 1)).toHaveLength(0);
  }, 120_000);

  test('SQS freezes: HTTP keeps working, events pile up in the outbox and drain afterwards', async () => {
    const bases = instances.map((i) => i.baseUrl);
    const w = await createWallet(bases[0]!, '100.00');
    const queued = { wallet: w, kind: 'WIN', amount: '5.00', externalTransactionId: `sqs-${randomUUID()}` };

    docker('pause', LOCALSTACK);
    try {
      // the financial path does not depend on the broker
      for (let i = 0; i < 10; i++) {
        const res = await submit(bases[i % 2]!, { wallet: w, kind: 'BET', amount: '1.00' });
        expect(res.status).toBe(201);
      }
      const ready = await fetch(`${bases[1]}/health/ready`);
      expect(ready.status).toBe(503);
      expect(((await ready.json()) as any).checks).toEqual({ postgres: 'up', sqs: 'down' });

      await new Promise((r) => setTimeout(r, 3_000));
      const [pending] = await sql<{ n: number }>(
        `select count(*)::int as n from outbox_messages where aggregate_id = ? and published_at is null`,
        [w.id],
      );
      expect(pending!.n).toBeGreaterThanOrEqual(20); // 10 × (Processed + BalanceChanged), opening may be out already
    } finally {
      docker('unpause', LOCALSTACK);
    }

    await sendMessage(sqs, urls.wager, wagerMessage(queued));
    await waitFor(
      async () => {
        const [row] = await sql<{ n: number }>(
          `select count(*)::int as n from outbox_messages where aggregate_id = ? and published_at is null`,
          [w.id],
        );
        return row!.n === 0;
      },
      { label: 'outbox drained', timeoutMs: 60_000, intervalMs: 500 },
    );
    await waitFor(
      async () => (await sql(`select 1 from wager_transactions where external_transaction_id = ? and status = 'PROCESSED'`, [queued.externalTransactionId])).length === 1,
      { label: 'consumer resumed', timeoutMs: 30_000 },
    );
    const [state] = await sql<{ balance: string }>(`select balance_amount::text as balance from wallets where id = ?`, [w.id]);
    expect(state!.balance).toBe('95.00');
    const failures = await (await fetch(`${bases[0]}/metrics`)).text();
    expect(failures).toMatch(/outbox_publish_failures_total \d+/);
  }, 120_000);
});
