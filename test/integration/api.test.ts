import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { TransactionalStore, UnitOfWork } from '../../src/application/ports';
import { SubmitWagerTransaction } from '../../src/application/use-cases/submit-wager-transaction.use-case';
import { parseWagerCommand } from '../../src/application/services/wager-command';
import {
  assertGlobalConsistency,
  createWallet,
  getJson,
  queueEnv,
  sql,
  startTestApp,
  submit,
  waitFor,
  wagerBody,
  walletState,
} from '../support/harness';

let app: Awaited<ReturnType<typeof startTestApp>>;
let base: string;

beforeAll(async () => {
  app = await startTestApp(queueEnv('api'));
  base = app.baseUrl;
});
afterAll(async () => {
  await assertGlobalConsistency();
  await app.stop();
});

describe('wallets', () => {
  test('creation with initial balance writes OPENING + CREDIT in the same transaction', async () => {
    const w = await createWallet(base, '1000.00');
    const state = await walletState(w.id);
    expect(state.wallet).toEqual({ balance: '1000.00', version: 1 });
    expect(state.transactions).toEqual([
      { status: 'PROCESSED', kind: 'OPENING', failure_code: null, external_transaction_id: `opening:${w.id}` },
    ]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.direction).toBe('CREDIT');
    const events = await sql(`select event_type from outbox_messages where aggregate_id = ?`, [w.id]);
    expect(events.map((e) => e.event_type)).toEqual(['WalletBalanceChanged']);
  });

  test('zero initial balance creates no ledger entry', async () => {
    const w = await createWallet(base, '0.00');
    const state = await walletState(w.id);
    expect(state.wallet).toEqual({ balance: '0.00', version: 1 });
    expect(state.entries).toHaveLength(0);
  });

  test('duplicate player + currency is a 409 conflict', async () => {
    const w = await createWallet(base, '1.00');
    const res = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: w.playerId, initialBalance: { amount: '5.00', currency: 'BRL' } }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('same player can hold wallets in different currencies', async () => {
    const w = await createWallet(base, '1.00');
    const res = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: w.playerId, initialBalance: { amount: '5.00', currency: 'USD' } }),
    });
    expect(res.status).toBe(201);
  });

  test('invalid money is a 400 (numbers, scientific notation, 3 decimals, negatives)', async () => {
    for (const amount of [10, '1e3', '1.001', '-1.00', 'NaN', '']) {
      const res = await fetch(`${base}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } }),
      });
      expect(res.status).toBe(400);
    }
  });

  test('ledger pagination uses a stable opaque cursor', async () => {
    const w = await createWallet(base, '100.00');
    for (let i = 0; i < 5; i++) await submit(base, { wallet: w, kind: 'BET', amount: '1.00' });
    const first = await getJson(`${base}/wallets/${w.id}/ledger?limit=4`);
    expect(first.status).toBe(200);
    expect(first.body.items.map((e: any) => e.walletVersion)).toEqual([6, 5, 4, 3]);
    const second = await getJson(`${base}/wallets/${w.id}/ledger?limit=4&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((e: any) => e.walletVersion)).toEqual([2, 1]);
    expect(second.body.nextCursor).toBeNull();
    expect((await getJson(`${base}/wallets/${w.id}/ledger?cursor=garbage`)).status).toBe(400);
  });

  test('reconciliation reports a consistent wallet', async () => {
    const w = await createWallet(base, '975.00');
    await submit(base, { wallet: w, kind: 'BET', amount: '25.00' });
    const res = await fetch(`${base}/wallets/${w.id}/reconciliation`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      walletId: w.id,
      storedBalance: { amount: '950.00', currency: 'BRL' },
      calculatedBalance: { amount: '950.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('unknown wallet is a 404', async () => {
    expect((await getJson(`${base}/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await getJson(`${base}/wallets/not-a-uuid`)).status).toBe(400);
  });
});

describe('wager transactions over HTTP', () => {
  test('BET is processed (201) and a replay returns the original result (200, idempotentReplay)', async () => {
    const w = await createWallet(base, '1000.00');
    const input = { wallet: w, kind: 'BET', amount: '25.00', externalTransactionId: `t-${randomUUID()}` };
    const first = await submit(base, input);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });
    await submit(base, { wallet: w, kind: 'BET', amount: '100.00' });
    const replay = await submit(base, input);
    expect(replay.status).toBe(200);
    // the balance observed at that moment, not the current one (875.00)
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('same key with a different payload is a 409 conflict, not a replay', async () => {
    const w = await createWallet(base, '100.00');
    const ext = `t-${randomUUID()}`;
    await submit(base, { wallet: w, kind: 'BET', amount: '10.00', externalTransactionId: ext });
    const conflict = await submit(base, { wallet: w, kind: 'BET', amount: '11.00', externalTransactionId: ext });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect((await walletState(w.id)).wallet.balance).toBe('90.00');
  });

  test('same external id under another key is a 409 conflict', async () => {
    const w = await createWallet(base, '100.00');
    const ext = `t-${randomUUID()}`;
    await submit(base, { wallet: w, kind: 'BET', amount: '10.00', externalTransactionId: ext });
    const res = await submit(base, { wallet: w, kind: 'BET', amount: '10.00', externalTransactionId: ext, idempotencyKey: 'other-key-' + ext });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });

  test('insufficient funds is a 422 business rejection, persisted and auditable', async () => {
    const w = await createWallet(base, '10.00');
    const res = await submit(base, { wallet: w, kind: 'BET', amount: '10.01' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    const tx = await getJson(`${base}/wagering/transactions/${res.body.transactionId}`);
    expect(tx.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', kind: 'BET' });
    expect((await walletState(w.id)).entries).toHaveLength(1);
  });

  test('currency conflict is a REJECTED transaction', async () => {
    const w = await createWallet(base, '10.00');
    const res = await submit(base, { wallet: w, kind: 'BET', amount: '1.00', currency: 'USD' });
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('missing header, OPENING kind and malformed payloads are 400', async () => {
    const w = await createWallet(base, '10.00');
    const { body } = wagerBody({ wallet: w, kind: 'BET', amount: '1.00' });
    const noKey = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as any).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await submit(base, { wallet: w, kind: 'OPENING', amount: '1.00' })).body.error.code).toBe('KIND_NOT_ALLOWED');
    expect((await submit(base, { wallet: w, kind: 'REFUND', amount: '1.00' })).status).toBe(400);
    expect((await submit(base, { wallet: w, kind: 'BET', amount: '1.001' })).status).toBe(400);
    const badJson = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
      body: '{not json',
    });
    expect(badJson.status).toBe(400);
  });

  test('unknown wallet in the body is a 404', async () => {
    const res = await submit(base, { wallet: { id: randomUUID(), playerId: randomUUID() }, kind: 'BET', amount: '1.00' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('WIN, LOSS, REFUND and ROLLBACK end to end', async () => {
    const w = await createWallet(base, '100.00');
    const bet = await submit(base, { wallet: w, kind: 'BET', amount: '40.00', externalTransactionId: `bet-${w.id}` });
    expect(bet.body.balance.amount).toBe('60.00');
    const loss = await submit(base, { wallet: w, kind: 'LOSS', amount: '0.00', reference: `bet-${w.id}` });
    expect(loss.status).toBe(201);
    expect(loss.body.balance.amount).toBe('60.00');
    const refund = await submit(base, { wallet: w, kind: 'REFUND', amount: '40.00', reference: `bet-${w.id}` });
    expect(refund.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' }, referenceTransactionId: bet.body.transactionId });
    const second = await submit(base, { wallet: w, kind: 'ROLLBACK', amount: '40.00', reference: `bet-${w.id}` });
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    const win = await submit(base, { wallet: w, kind: 'WIN', amount: '30.00', externalTransactionId: `win-${w.id}` });
    expect(win.body.balance.amount).toBe('130.00');
    const rbWin = await submit(base, { wallet: w, kind: 'ROLLBACK', amount: '30.00', reference: `win-${w.id}` });
    expect(rbWin.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });

    const byExternal = await getJson(`${base}/providers/provider-a/wagering/transactions/win-${w.id}`);
    expect(byExternal.body).toMatchObject({ kind: 'WIN', status: 'PROCESSED', money: { amount: '30.00', currency: 'BRL' } });
    const state = await walletState(w.id);
    // OPENING, BET, REFUND, WIN, ROLLBACK → 5 entries; LOSS and the rejected ROLLBACK have none
    expect(state.entries.map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT', 'CREDIT', 'DEBIT']);
  });

  test("naming another player's wallet is a 422 that reveals nothing about it", async () => {
    const victim = await createWallet(base, '777.00');
    const res = await submit(base, { wallet: { id: victim.id, playerId: randomUUID() }, kind: 'BET', amount: '1.00' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ failureCode: 'PLAYER_WALLET_MISMATCH', balance: null });
    const [event] = await sql(
      `select payload from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionRejected'`,
      [victim.id],
    );
    expect(event).toBeDefined();
    expect(JSON.stringify(event!.payload)).not.toContain('777');
    expect((await walletState(victim.id)).wallet.balance).toBe('777.00');
  });

  test('a BET is paid or reversed, never both', async () => {
    const w = await createWallet(base, '100.00');
    const betId = `bet-${w.id}`;
    await submit(base, { wallet: w, kind: 'BET', amount: '10.00', externalTransactionId: betId });
    const win = await submit(base, { wallet: w, kind: 'WIN', amount: '50.00', reference: betId, externalTransactionId: `win-${w.id}` });
    expect(win.body.balance.amount).toBe('140.00');

    // refunding the BET now would return the stake on top of the winnings
    const early = await submit(base, { wallet: w, kind: 'REFUND', amount: '10.00', reference: betId });
    expect(early.status).toBe(422);
    expect(early.body.failureCode).toBe('REFERENCE_ALREADY_SETTLED');

    // roll the WIN back first, then the BET can be refunded
    const rbWin = await submit(base, { wallet: w, kind: 'ROLLBACK', amount: '50.00', reference: `win-${w.id}` });
    expect(rbWin.body.balance.amount).toBe('90.00');
    const refund = await submit(base, { wallet: w, kind: 'REFUND', amount: '10.00', reference: betId });
    expect(refund.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });

    // and a WIN arriving after the refund pays nothing
    const late = await submit(base, { wallet: w, kind: 'WIN', amount: '50.00', reference: betId });
    expect(late.status).toBe(422);
    expect(late.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect((await walletState(w.id)).wallet.balance).toBe('100.00');
  });

  test('ROLLBACK of a WIN that would make the balance negative is rejected with its own code', async () => {
    const w = await createWallet(base, '0.00');
    await submit(base, { wallet: w, kind: 'WIN', amount: '50.00', externalTransactionId: `w-${w.id}` });
    await submit(base, { wallet: w, kind: 'BET', amount: '40.00' });
    const rb = await submit(base, { wallet: w, kind: 'ROLLBACK', amount: '50.00', reference: `w-${w.id}` });
    expect(rb.status).toBe(422);
    expect(rb.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect((await walletState(w.id)).wallet.balance).toBe('10.00');
  });

  test('reference from another wallet / round is rejected', async () => {
    const a = await createWallet(base, '100.00');
    const b = await createWallet(base, '100.00');
    await submit(base, { wallet: a, kind: 'BET', amount: '10.00', externalTransactionId: `x-${a.id}` });
    const other = await submit(base, { wallet: b, kind: 'REFUND', amount: '10.00', reference: `x-${a.id}` });
    expect(other.body.failureCode).toBe('REFERENCE_MISMATCH');
    const round = await submit(base, { wallet: a, kind: 'REFUND', amount: '10.00', reference: `x-${a.id}`, roundId: 'round-2' });
    expect(round.body.failureCode).toBe('REFERENCE_MISMATCH');
  });

  test('a reference that never arrives ends REJECTED with REFERENCE_NOT_FOUND and an event', async () => {
    const pending = await startTestApp({ ...queueEnv('api-pending'), APP_ROLES: 'pending-reference' });
    try {
      const w = await createWallet(base, '100.00');
      const res = await submit(base, { wallet: w, kind: 'ROLLBACK', amount: '5.00', reference: `ghost-${w.id}` });
      expect(res.status).toBe(202);
      expect(res.body.status).toBe('PENDING_REFERENCE');
      const final = await waitFor(
        async () => {
          const tx = await getJson(`${base}/wagering/transactions/${res.body.transactionId}`);
          return tx.body.status === 'REJECTED' ? tx.body : undefined;
        },
        { label: 'reference exhaustion', timeoutMs: 20_000 },
      );
      expect(final.failureCode).toBe('REFERENCE_NOT_FOUND');
      expect(final.attempts).toBeGreaterThanOrEqual(3);
      const events = await sql(`select event_type from outbox_messages where aggregate_id = ? order by occurred_at`, [w.id]);
      expect(events.map((e) => e.event_type)).toEqual([
        'WalletBalanceChanged',
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);
    } finally {
      await pending.stop();
    }
  });
});

describe('atomicity', () => {
  test('a failure late in the transaction rolls back transaction, wallet, ledger, inbox and outbox together', async () => {
    const w = await createWallet(base, '100.00');
    const c = app.container;
    const failingUow: UnitOfWork = {
      transaction: (work, options) =>
        c.uow.transaction(
          (store: TransactionalStore) =>
            work({
              ...store,
              outbox: {
                enqueue: async (messages) => {
                  await store.outbox.enqueue(messages);
                  throw new Error('boom after every write');
                },
              },
            }),
          options,
        ),
    };
    const submitter = new SubmitWagerTransaction(failingUow, c.clock, c.ids, c.metrics, c.logger, c.config.pendingReference);
    const { idempotencyKey, body } = wagerBody({ wallet: w, kind: 'BET', amount: '30.00' });
    const messageId = `atomic-${randomUUID()}`;
    await expect(
      submitter.execute(parseWagerCommand(body, idempotencyKey), {
        source: 'sqs',
        correlationId: 'atomicity',
        inbox: { consumerName: 'test', messageId, payloadHash: 'a'.repeat(64) },
      }),
    ).rejects.toThrow('boom after every write');

    const state = await walletState(w.id);
    expect(state.wallet).toEqual({ balance: '100.00', version: 1 });
    expect(state.entries).toHaveLength(1);
    expect(state.transactions.map((t) => t.kind)).toEqual(['OPENING']);
    expect(await sql(`select 1 from inbox_messages where message_id = ?`, [messageId])).toHaveLength(0);
    expect(await sql(`select 1 from outbox_messages where aggregate_id = ? and event_type <> 'WalletBalanceChanged'`, [w.id])).toHaveLength(0);
  });
});

describe('operations', () => {
  test('health endpoints and metrics are public', async () => {
    expect((await getJson(`${base}/health/live`)).body.status).toBe('up');
    expect(await getJson(`${base}/health/ready`)).toEqual({
      status: 200,
      body: { status: 'up', checks: { postgres: 'up', sqs: 'up' } },
    });
    const metrics = await (await fetch(`${base}/metrics`)).text();
    for (const name of [
      'wager_transactions_total',
      'wager_duplicates_total',
      'wager_retries_total',
      'wallet_lock_conflicts_total',
      'sqs_dlq_messages_total',
      'outbox_lag_seconds',
      'wager_processing_duration_seconds',
    ]) {
      expect(metrics).toContain(name);
    }
  });

  test('every response carries a correlation id', async () => {
    const res = await fetch(`${base}/health/live`, { headers: { 'x-correlation-id': 'corr-123' } });
    expect(res.headers.get('x-correlation-id')).toBe('corr-123');
  });
});
