import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { QueueUrls } from '../../src/infrastructure/sqs/sqs';
import {
  assertGlobalConsistency,
  BASE_ENV,
  createWallet,
  drain,
  queueEnv,
  ROOT,
  sql,
  startTestApp,
  submit,
  testQueues,
  waitFor,
} from '../support/harness';

const env = queueEnv('outbox');
let api: Awaited<ReturnType<typeof startTestApp>>;
let sqs: SQSClient;
let urls: QueueUrls;

beforeAll(async () => {
  ({ sqs, urls } = await testQueues(env));
  api = await startTestApp({ ...env, APP_ROLES: 'api' });
});
afterAll(async () => {
  await api.stop();
  await assertGlobalConsistency();
});

/** Creates wallets + bets with NO publisher running: rows are committed, nothing is published. */
async function produceEvents(wallets: number, betsPerWallet: number): Promise<string[]> {
  const ids: string[] = [];
  await Promise.all(
    Array.from({ length: wallets }, async () => {
      const w = await createWallet(api.baseUrl, '100.00');
      ids.push(w.id);
      for (let i = 0; i < betsPerWallet; i++) await submit(api.baseUrl, { wallet: w, kind: 'BET', amount: '1.00' });
    }),
  );
  return ids;
}

async function pendingFor(aggregateIds: string[]) {
  const rows = await sql<{ id: string; attempts: number; published_at: Date | null }>(
    `select id, attempts, published_at from outbox_messages where aggregate_id in (${aggregateIds.map(() => '?').join(',')})`,
    aggregateIds,
  );
  return { total: rows.length, pending: rows.filter((r) => !r.published_at), rows };
}

async function collectEvents(aggregateIds: Set<string>, expected: number): Promise<Message[]> {
  const received: Message[] = [];
  await waitFor(
    async () => {
      const batch = await drain(sqs, urls.events, 1);
      received.push(...batch.filter((m) => aggregateIds.has(JSON.parse(m.Body!).aggregateId)));
      return received.length >= expected;
    },
    { label: `${expected} events`, timeoutMs: 30_000 },
  );
  // make sure nothing else trickles in
  for (let i = 0; i < 2; i++) {
    const batch = await drain(sqs, urls.events, 1);
    received.push(...batch.filter((m) => aggregateIds.has(JSON.parse(m.Body!).aggregateId)));
  }
  return received;
}

describe('transactional outbox', () => {
  test('events are committed with the transaction and published later, as stable JSON envelopes', async () => {
    const [walletId] = await produceEvents(1, 1);
    const before = await pendingFor([walletId!]);
    expect(before.total).toBe(3); // opening balance change, bet balance change, bet processed
    expect(before.pending).toHaveLength(3);

    const publisher = await startTestApp({ ...env, APP_ROLES: 'outbox' });
    try {
      const events = await collectEvents(new Set([walletId!]), 3);
      const envelopes = events.map((m) => JSON.parse(m.Body!));
      expect(envelopes.map((e) => e.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged']);
      const change = envelopes.find((e) => e.eventType === 'WalletBalanceChanged' && e.data.direction === 'DEBIT');
      expect(change).toMatchObject({
        version: 1,
        aggregateId: walletId,
        data: {
          walletId,
          direction: 'DEBIT',
          money: { amount: '1.00', currency: 'BRL' },
          balanceBefore: { amount: '100.00', currency: 'BRL' },
          balanceAfter: { amount: '99.00', currency: 'BRL' },
          walletVersion: 2,
        },
      });
      expect(typeof change.eventId).toBe('string');
      expect(typeof change.correlationId).toBe('string');
      expect(new Date(change.occurredAt).toISOString()).toBe(change.occurredAt);
      await waitFor(async () => (await pendingFor([walletId!])).pending.length === 0, { label: 'marked published' });
    } finally {
      await publisher.stop();
    }
  });

  test('two concurrent publishers on the same outbox publish every event exactly once', async () => {
    const walletIds = await produceEvents(10, 5);
    const { total } = await pendingFor(walletIds);
    expect(total).toBe(10 * (1 + 5 * 2));

    const a = await startTestApp({ ...env, APP_ROLES: '', OUTBOX_BATCH_SIZE: '7' });
    const b = await startTestApp({ ...env, APP_ROLES: '', OUTBOX_BATCH_SIZE: '7' });
    try {
      const counts = { a: 0, b: 0 };
      const run = async (name: 'a' | 'b', app: typeof a) => {
        for (;;) {
          const n = await app.container.outboxPublisher.publishBatch();
          counts[name] += n;
          if (n === 0 && (await pendingFor(walletIds)).pending.length === 0) return;
        }
      };
      await Promise.all([run('a', a), run('b', b)]);
      expect(counts.a).toBeGreaterThan(0);
      expect(counts.b).toBeGreaterThan(0);

      const events = await collectEvents(new Set(walletIds), total);
      const eventIds = events.map((m) => JSON.parse(m.Body!).eventId);
      expect(new Set(eventIds).size).toBe(total);
      expect(eventIds).toHaveLength(total);
      // order per wallet is preserved by the FIFO group (= aggregateId)
      for (const walletId of walletIds) {
        const versions = events
          .map((m) => JSON.parse(m.Body!))
          .filter((e) => e.aggregateId === walletId && e.eventType === 'WalletBalanceChanged')
          .map((e) => e.data.walletVersion);
        expect(versions).toEqual([...versions].sort((x, y) => x - y));
      }
    } finally {
      await a.stop();
      await b.stop();
    }
  }, 60_000);

  test('publisher dies after sending but before marking: another instance re-publishes the same event ids', async () => {
    const walletIds = await produceEvents(2, 1);
    const child = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...BASE_ENV,
        ...env,
        APP_ROLES: 'outbox',
        OUTBOX_BATCH_SIZE: '100000',
        FAULT_INJECTION: 'crash-after-publish',
        LOG_LEVEL: 'silent',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    await child.exited;
    expect(child.signalCode).toBe('SIGKILL');

    // the SQS send happened, the commit did not: rows are still pending
    const afterCrash = await pendingFor(walletIds);
    expect(afterCrash.pending).toHaveLength(afterCrash.total);

    const survivor = await startTestApp({ ...env, APP_ROLES: 'outbox' });
    try {
      await waitFor(async () => (await pendingFor(walletIds)).pending.length === 0, { label: 'recovered' });
      const events = await collectEvents(new Set(walletIds), afterCrash.total);
      const ids = events.map((m) => JSON.parse(m.Body!).eventId);
      // Every outbox id was delivered; the FIFO dedup id (= eventId) absorbs the
      // re-send, and any duplicate that slips through carries the same eventId.
      expect(new Set(ids)).toEqual(new Set(afterCrash.rows.map((r) => r.id)));
    } finally {
      await survivor.stop();
    }
  }, 60_000);

  test('an event waiting for retry is never overtaken by a later event of the same wallet', async () => {
    const [walletId] = await produceEvents(1, 3);
    const { total } = await pendingFor([walletId!]);
    // SQS refuses the first event (OPENING's WalletBalanceChanged); everything after it must wait
    const publisher = await startTestApp({ ...env, APP_ROLES: '', FAULT_INJECTION: 'reject-first-event', OUTBOX_RETRY_BASE_MS: '200' });
    try {
      expect(await publisher.container.outboxPublisher.publishBatch()).toBe(0);
      expect((await pendingFor([walletId!])).pending).toHaveLength(total);
      await waitFor(
        async () => {
          await publisher.container.outboxPublisher.publishBatch();
          return (await pendingFor([walletId!])).pending.length === 0;
        },
        { label: 'published after retry' },
      );
    } finally {
      await publisher.stop();
    }
    const received = (await collectEvents(new Set([walletId!]), total)).map((m) => JSON.parse(m.Body!));
    const expected = await sql<{ id: string }>(`select id from outbox_messages where aggregate_id = ? order by occurred_at, id`, [walletId]);
    expect(received.map((e) => e.eventId)).toEqual(expected.map((r) => r.id));
  }, 30_000);

  test('when SQS rejects the publication the row is rescheduled with backoff, then published', async () => {
    const walletIds = await produceEvents(1, 0);
    const failing = await startTestApp({ ...env, APP_ROLES: '', FAULT_INJECTION: 'fail-publish', OUTBOX_RETRY_BASE_MS: '300' });
    try {
      await failing.container.outboxPublisher.publishBatch();
      const [row] = (await pendingFor(walletIds)).rows;
      expect(row!.attempts).toBe(1);
      expect(row!.published_at).toBeNull();
      const [detail] = await sql(`select next_attempt_at > now() as later, last_error from outbox_messages where id = ?`, [row!.id]);
      expect(detail).toMatchObject({ later: true, last_error: 'fault injected: fail-publish' });
    } finally {
      await failing.stop();
    }
    const healthy = await startTestApp({ ...env, APP_ROLES: 'outbox' });
    try {
      await waitFor(async () => (await pendingFor(walletIds)).pending.length === 0, { label: 'published after retry' });
    } finally {
      await healthy.stop();
    }
  }, 30_000);
});
