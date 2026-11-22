import type { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { QueueUrls } from '../../src/infrastructure/sqs/sqs';
import {
  assertGlobalConsistency,
  createWallet,
  db,
  drain,
  queueEnv,
  sendMessage,
  sql,
  startTestApp,
  testQueues,
  waitFor,
  wagerMessage,
  walletState,
} from '../support/harness';

const env = queueEnv('sqs');
let api: Awaited<ReturnType<typeof startTestApp>>;
let consumer: Awaited<ReturnType<typeof startTestApp>>;
let sqs: SQSClient;
let urls: QueueUrls;

beforeAll(async () => {
  ({ sqs, urls } = await testQueues(env));
  api = await startTestApp({ ...env, APP_ROLES: 'api' });
  consumer = await startTestApp({ ...env, APP_ROLES: 'consumer,pending-reference' });
});
afterAll(async () => {
  await consumer.stop();
  await api.stop();
  await assertGlobalConsistency();
});

const inboxRows = (messageId: string) => sql(`select processed_at from inbox_messages where message_id = ?`, [messageId]);
const txStatus = async (walletId: string, ext: string) =>
  (await walletState(walletId)).transactions.find((t) => t.external_transaction_id === ext);

/**
 * Holds a row lock on a wallet from another connection. `FOR NO KEY UPDATE`
 * conflicts with the service's `FOR UPDATE` (→ lock timeout) but not with the
 * key-share lock taken by foreign keys, so a FAILED row can still be written.
 */
async function holdWalletLock(walletId: string, ms: number): Promise<{ released: Promise<void> }> {
  const orm = await db();
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const released = orm.em.fork({ useContext: false }).transactional(async (em) => {
    await em.execute(`select id from wallets where id = ? for no key update`, [walletId]);
    acquired();
    await new Promise((r) => setTimeout(r, ms));
  });
  await ready;
  return { released };
}

async function dlqMessages(expected: number) {
  const seen: Awaited<ReturnType<typeof drain>> = [];
  await waitFor(
    async () => {
      seen.push(...(await drain(sqs, urls.wagerDlq, 1)));
      return seen.length >= expected;
    },
    { label: 'dlq messages', timeoutMs: 20_000 },
  );
  return seen;
}

describe('SQS consumer', () => {
  test('processes a message through the same use case and acks after commit', async () => {
    const w = await createWallet(api.baseUrl, '100.00');
    const msg = wagerMessage({ wallet: w, kind: 'BET', amount: '25.00', externalTransactionId: `sqs-${w.id}` });
    await sendMessage(sqs, urls.wager, msg);
    await waitFor(async () => (await txStatus(w.id, `sqs-${w.id}`))?.status === 'PROCESSED', { label: 'processed' });
    expect((await walletState(w.id)).wallet.balance).toBe('75.00');
    expect((await inboxRows(msg.messageId))[0]?.processed_at).toBeTruthy();
    await waitFor(async () => (await drain(sqs, urls.wager, 1)).length === 0 || undefined, { label: 'queue empty' });
  });

  test('the same message delivered many times is applied once (persistent inbox)', async () => {
    const w = await createWallet(api.baseUrl, '100.00');
    const msg = wagerMessage({ wallet: w, kind: 'BET', amount: '10.00' });
    await Promise.all(Array.from({ length: 8 }, () => sendMessage(sqs, urls.wager, msg)));
    await waitFor(async () => (await walletState(w.id)).entries.length === 2, { label: 'debit' });
    await new Promise((r) => setTimeout(r, 1500));
    const state = await walletState(w.id);
    expect(state.wallet.balance).toBe('90.00');
    expect(state.entries).toHaveLength(2);
    expect(await inboxRows(msg.messageId)).toHaveLength(1);
  });

  test('different messages with the same idempotency key are replays', async () => {
    const w = await createWallet(api.baseUrl, '100.00');
    const input = { wallet: w, kind: 'BET', amount: '10.00', externalTransactionId: `same-${w.id}` };
    await sendMessage(sqs, urls.wager, wagerMessage(input));
    await sendMessage(sqs, urls.wager, wagerMessage(input));
    await waitFor(async () => (await walletState(w.id)).entries.length === 2, { label: 'debit' });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await walletState(w.id)).wallet.balance).toBe('90.00');
  });

  test('ROLLBACK delivered before its BET waits and is applied afterwards', async () => {
    const w = await createWallet(api.baseUrl, '100.00');
    const betId = `late-bet-${w.id}`;
    await sendMessage(sqs, urls.wager, wagerMessage({ wallet: w, kind: 'ROLLBACK', amount: '20.00', reference: betId, externalTransactionId: `rb-${w.id}` }), { groupId: `rb-${w.id}` });
    await waitFor(async () => (await txStatus(w.id, `rb-${w.id}`))?.status === 'PENDING_REFERENCE', { label: 'pending' });
    await sendMessage(sqs, urls.wager, wagerMessage({ wallet: w, kind: 'BET', amount: '20.00', externalTransactionId: betId }));
    await waitFor(async () => (await txStatus(w.id, `rb-${w.id}`))?.status === 'PROCESSED', { label: 'rollback applied' });
    const state = await walletState(w.id);
    expect(state.wallet.balance).toBe('100.00');
    expect(state.entries.map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
  });

  test('invalid messages, unknown wallets and idempotency conflicts go to the DLQ', async () => {
    const w = await createWallet(api.baseUrl, '100.00');
    const ext = `conflict-${w.id}`;
    await sendMessage(sqs, urls.wager, {}, { raw: '{"not":"valid"', groupId: 'bad' });
    await sendMessage(sqs, urls.wager, wagerMessage({ wallet: { id: randomUUID(), playerId: w.playerId }, kind: 'BET', amount: '1.00' }));
    await sendMessage(sqs, urls.wager, wagerMessage({ wallet: w, kind: 'BET', amount: '1.00', externalTransactionId: ext }));
    await waitFor(async () => (await txStatus(w.id, ext))?.status === 'PROCESSED');
    await sendMessage(sqs, urls.wager, wagerMessage({ wallet: w, kind: 'BET', amount: '2.00', externalTransactionId: ext }));
    const dead = await dlqMessages(3);
    const reasons = dead.map((m) => m.MessageAttributes?.deadLetterReason?.StringValue).sort();
    expect(reasons).toEqual(['IDEMPOTENCY_KEY_CONFLICT', 'INVALID_MESSAGE', 'WALLET_NOT_FOUND']);
    expect((await walletState(w.id)).wallet.balance).toBe('99.00');
  });

  test('a reused messageId with a different body is dead-lettered, not dropped as a duplicate', async () => {
    const w = await createWallet(api.baseUrl, '100.00');
    const first = wagerMessage({ wallet: w, kind: 'BET', amount: '10.00', externalTransactionId: `first-${w.id}` });
    await sendMessage(sqs, urls.wager, first);
    await waitFor(async () => (await txStatus(w.id, `first-${w.id}`))?.status === 'PROCESSED', { label: 'first' });

    const reused = wagerMessage({ wallet: w, kind: 'BET', amount: '30.00', externalTransactionId: `second-${w.id}` }, first.messageId);
    await sendMessage(sqs, urls.wager, reused);
    const [dead] = await dlqMessages(1);
    expect(dead!.MessageAttributes?.deadLetterReason?.StringValue).toBe('INBOX_MESSAGE_CONFLICT');
    expect(JSON.parse(dead!.Body!).data.externalTransactionId).toBe(`second-${w.id}`);
    expect((await walletState(w.id)).wallet.balance).toBe('90.00');
  });

  test('transient failure (wallet lock timeout) is retried with backoff and then succeeds', async () => {
    const w = await createWallet(api.baseUrl, '100.00');
    const ext = `transient-${w.id}`;
    const lock = await holdWalletLock(w.id, 3_000);
    await sendMessage(sqs, urls.wager, wagerMessage({ wallet: w, kind: 'BET', amount: '5.00', externalTransactionId: ext }));
    await lock.released;
    await waitFor(async () => (await txStatus(w.id, ext))?.status === 'PROCESSED', { label: 'retried', timeoutMs: 20_000 });
    const metrics = await consumer.container.metrics.registry.getSingleMetricAsString('wager_retries_total');
    expect(metrics).toContain('operation="sqs-consume",reason="LOCK_TIMEOUT"');
    expect((await walletState(w.id)).wallet.balance).toBe('95.00');
  }, 30_000);

  test('a message that keeps failing is dead-lettered after maxReceiveCount and recorded as FAILED', async () => {
    const w = await createWallet(api.baseUrl, '100.00');
    const ext = `exhausted-${w.id}`;
    const lock = await holdWalletLock(w.id, 14_000);
    await sendMessage(sqs, urls.wager, wagerMessage({ wallet: w, kind: 'BET', amount: '5.00', externalTransactionId: ext }));
    const dead = await dlqMessages(1);
    await lock.released;
    expect(dead[0]!.MessageAttributes?.deadLetterReason?.StringValue).toBe('RETRIES_EXHAUSTED');
    const tx = await waitFor(async () => txStatus(w.id, ext), { label: 'failed tx' });
    expect(tx).toMatchObject({ status: 'FAILED', failure_code: 'PROCESSING_RETRIES_EXHAUSTED' });
    expect((await walletState(w.id)).wallet.balance).toBe('100.00');
  }, 40_000);
});

describe('SQS consumer, ack failure after commit', () => {
  test('a failed delete after the commit is not treated as a processing failure', async () => {
    const ackEnv = queueEnv('ack');
    const queues = await testQueues(ackEnv);
    const flaky = await startTestApp({ ...ackEnv, APP_ROLES: 'consumer', FAULT_INJECTION: 'fail-ack-once' });
    try {
      const w = await createWallet(api.baseUrl, '100.00');
      const msg = wagerMessage({ wallet: w, kind: 'BET', amount: '10.00', externalTransactionId: `ack-${w.id}` });
      await sendMessage(queues.sqs, queues.urls.wager, msg);
      await waitFor(async () => (await txStatus(w.id, `ack-${w.id}`))?.status === 'PROCESSED', { label: 'processed' });

      // the message comes back after its visibility timeout and is acked as a duplicate
      const metrics = async () => flaky.container.metrics.registry.metrics();
      await waitFor(async () => (await metrics()).includes('wager_duplicates_total{source="sqs"'), {
        label: 'redelivery absorbed',
        timeoutMs: 20_000,
      });
      const text = await metrics();
      expect(text).toContain('sqs_messages_total{outcome="ack-failed"} 1');
      expect(text).toContain('sqs_messages_total{outcome="acked"} 1');
      // before the fix the failed delete went down the transient-failure path
      expect(text).not.toContain('sqs_messages_total{outcome="retry-scheduled"}');
      expect(text).not.toContain('operation="sqs-consume"');
      expect(await drain(queues.sqs, queues.urls.wagerDlq, 1)).toHaveLength(0);
      expect((await walletState(w.id)).wallet.balance).toBe('90.00');
    } finally {
      await flaky.stop();
    }
  }, 40_000);
});
