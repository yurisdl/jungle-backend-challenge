import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertGlobalConsistency, createWallet, db, queueEnv, sql, startTestApp, submit } from '../support/harness';

/**
 * The pending-reference worker, driven tick by tick (no background loop):
 * a transaction that keeps failing must not starve the others, and the
 * dependents of a transaction that ends are re-evaluated right away.
 */
let app: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  // The worker runs, but its first idle sleep lasts the whole file: the tests drive its ticks by hand.
  app = await startTestApp({
    ...queueEnv('pending'),
    APP_ROLES: 'api,pending-reference',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '600000',
    PENDING_REFERENCE_BATCH_SIZE: '1',
    DB_LOCK_TIMEOUT_MS: '300',
  });
});
afterAll(async () => {
  await app.stop();
  await assertGlobalConsistency();
});

const tick = () => (app.container.pendingReferenceWorker as unknown as { tick(): Promise<number> }).tick();
const row = async (id: string) =>
  (await sql<{ status: string; attempts: number; failure_code: string | null; due: boolean }>(
    `select status, attempts, failure_code, next_attempt_at <= now() as due from wager_transactions where id = ?`,
    [id],
  ))[0]!;

/** Holds the wallet row lock from another connection, so settling it times out. */
async function holdWalletLock(walletId: string) {
  const orm = await db();
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((r) => (acquired = r));
  const done = orm.em.fork({ useContext: false }).transactional(async (em) => {
    await em.execute(`select id from wallets where id = ? for no key update`, [walletId]);
    acquired();
    await new Promise<void>((r) => (release = r));
  });
  await ready;
  return async () => {
    release();
    await done;
  };
}

/** A ROLLBACK whose BET arrives later: PENDING_REFERENCE, then due. */
async function dueRollback(wallet: { id: string; playerId: string }, amount: string) {
  const bet = `bet-${crypto.randomUUID()}`;
  const rb = await submit(app.baseUrl, { wallet, kind: 'ROLLBACK', amount, reference: bet });
  expect(rb.status).toBe(202);
  await submit(app.baseUrl, { wallet, kind: 'BET', amount, externalTransactionId: bet });
  return rb.body.transactionId as string;
}

describe('pending-reference worker', () => {
  test('a transaction that keeps failing is postponed and does not block the queue', async () => {
    const stuckWallet = await createWallet(app.baseUrl, '100.00');
    const otherWallet = await createWallet(app.baseUrl, '100.00');
    const stuck = await dueRollback(stuckWallet, '10.00');
    const other = await dueRollback(otherWallet, '10.00');
    // `stuck` heads the queue (batch size 1), `other` comes next: older than
    // anything another test file may have left in the shared database
    await sql(`update wager_transactions set next_attempt_at = now() - interval '100 years' where id = ?`, [stuck]);
    await sql(`update wager_transactions set next_attempt_at = now() - interval '99 years' where id = ?`, [other]);

    const release = await holdWalletLock(stuckWallet.id);
    try {
      await tick(); // stuck: lock timeout → postponed
      expect(await row(stuck)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1, due: false });
      await tick(); // the queue moves on
      expect((await row(other)).status).toBe('PROCESSED');
    } finally {
      await release();
    }
  }, 30_000);

  test('after the attempt budget a transaction that keeps failing ends FAILED', async () => {
    const w = await createWallet(app.baseUrl, '100.00');
    const stuck = await dueRollback(w, '5.00');
    await sql(`update wager_transactions set attempts = 3, next_attempt_at = now() - interval '100 years' where id = ?`, [stuck]);
    const release = await holdWalletLock(w.id);
    try {
      await tick();
    } finally {
      await release();
    }
    expect(await row(stuck)).toMatchObject({ status: 'FAILED', failure_code: 'PROCESSING_RETRIES_EXHAUSTED' });
    expect((await sql(`select balance_amount from wallets where id = ?`, [w.id]))[0]).toMatchObject({ balance_amount: '95.00' }); // the BET stands, the ROLLBACK did nothing
  }, 30_000);

  test('dependents of a rejected transaction are woken at once', async () => {
    const w = await createWallet(app.baseUrl, '100.00');
    const refundExt = `refund-${w.id}`;
    // REFUND of a BET that never arrives, and a ROLLBACK of that REFUND
    const refund = await submit(app.baseUrl, { wallet: w, kind: 'REFUND', amount: '10.00', reference: `ghost-${w.id}`, externalTransactionId: refundExt });
    const rollback = await submit(app.baseUrl, { wallet: w, kind: 'ROLLBACK', amount: '10.00', reference: refundExt });
    expect([refund.status, rollback.status]).toEqual([202, 202]);
    // the REFUND is on its last attempt, the ROLLBACK waits far in the future
    await sql(`update wager_transactions set attempts = 3, next_attempt_at = now() - interval '1 hour' where id = ?`, [refund.body.transactionId]);
    await sql(`update wager_transactions set next_attempt_at = now() + interval '1 hour' where id = ?`, [rollback.body.transactionId]);

    await app.container.retryPendingReference.execute(refund.body.transactionId);
    expect(await row(refund.body.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    expect((await row(rollback.body.transactionId)).due).toBe(true);
  });
});
