import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { assertGlobalConsistency, createWallet, queueEnv, startTestApp, submit, walletState } from '../support/harness';

let app: Awaited<ReturnType<typeof startTestApp>>;
let base: string;

beforeAll(async () => {
  app = await startTestApp({ ...queueEnv('hot'), DB_POOL_MAX: '40' });
  base = app.baseUrl;
});
afterAll(async () => {
  await app.stop();
  await assertGlobalConsistency();
});

describe('concurrency (real parallel requests against PostgreSQL)', () => {
  test('the same bet sent 50 times in parallel produces a single debit', async () => {
    const w = await createWallet(base, '100.00');
    const input = { wallet: w, kind: 'BET', amount: '10.00', externalTransactionId: `same-${randomUUID()}` };
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(base, input)));

    const ids = new Set(results.map((r) => r.body.transactionId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    for (const r of results) expect(r.body.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    const state = await walletState(w.id);
    expect(state.wallet).toEqual({ balance: '90.00', version: 2 });
    expect(state.entries.filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
  });

  test('mandatory scenario: 100.00 BRL, two parallel bets of 80.00', async () => {
    const w = await createWallet(base, '100.00');
    const a = { wallet: w, kind: 'BET', amount: '80.00', externalTransactionId: `a-${randomUUID()}` };
    const b = { wallet: w, kind: 'BET', amount: '80.00', externalTransactionId: `b-${randomUUID()}` };
    const [ra, rb] = await Promise.all([submit(base, a), submit(base, b)]);

    const statuses = [ra.body.status, rb.body.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = [ra, rb].find((r) => r.body.status === 'REJECTED')!;
    expect(rejected.status).toBe(422);
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    // retries of both requests change nothing
    const retries = await Promise.all([submit(base, a), submit(base, b), submit(base, a), submit(base, b)]);
    for (const r of retries) expect(r.body.idempotentReplay).toBe(true);

    const state = await walletState(w.id);
    expect(state.wallet.balance).toBe('20.00');
    expect(state.entries.filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    expect(state.transactions.filter((t) => t.kind === 'BET').map((t) => t.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
  });

  test('hot wallet: 120 different bets compete for a 50.00 balance', async () => {
    const w = await createWallet(base, '50.00');
    const results = await Promise.all(
      Array.from({ length: 120 }, () => submit(base, { wallet: w, kind: 'BET', amount: '1.00' })),
    );
    expect(results.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(50);
    expect(results.filter((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(70);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    const state = await walletState(w.id);
    expect(state.wallet).toEqual({ balance: '0.00', version: 51 });
    expect(state.entries).toHaveLength(51);
  }, 30_000);

  test('credits and debits interleaved on the same wallet never lose an update', async () => {
    const w = await createWallet(base, '10.00');
    const ops = Array.from({ length: 80 }, (_, i) =>
      submit(base, { wallet: w, kind: i % 2 === 0 ? 'WIN' : 'BET', amount: i % 2 === 0 ? '2.00' : '1.00' }),
    );
    const results = await Promise.all(ops);
    const processed = results.filter((r) => r.body.status === 'PROCESSED');
    const wins = results.filter((r, i) => i % 2 === 0 && r.body.status === 'PROCESSED').length;
    const bets = processed.length - wins;
    const state = await walletState(w.id);
    expect(Number(state.wallet.balance)).toBe(10 + wins * 2 - bets);
    expect(state.wallet.version).toBe(1 + processed.length);
  }, 30_000);

  test('different wallets are processed in parallel without interfering', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet(base, '100.00')));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 10 }, () => submit(base, { wallet: w, kind: 'BET', amount: '5.00' }))),
    );
    const elapsed = performance.now() - started;
    for (const w of wallets) {
      const state = await walletState(w.id);
      expect(state.wallet).toEqual({ balance: '50.00', version: 11 });
    }
    // 200 transactions: no global lock serialising wallets
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);
});
