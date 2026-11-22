import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  FailureCode,
  LedgerDirection,
  Money,
  type ReferenceLookup,
  settleWager,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus as S,
  Wallet,
  type WalletLedgerEntry,
} from '../../src/domain';
import { deliveryArb, type GeneratedOp, historyArb } from '../support/wager-arbitraries';

/**
 * Property-based tests of the settlement rules: thousands of random
 * histories (bets, wins, losses, refunds, rollbacks, references to earlier,
 * later and never-arriving transactions), delivered shuffled and with
 * duplicates. Whatever the order, the financial invariants must hold.
 */
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const ext = (i: number) => `op-${i}`;

function simulate(ops: GeneratedOp[], delivery: number[], opening: string) {
  const at = new Date('2026-01-01T00:00:00Z');
  let seq = 0;
  const { wallet, openingEntry } = Wallet.open({
    id: 'w',
    playerId: 'p',
    initialBalance: brl(opening),
    at,
    opening: { transactionId: 'opening', ledgerEntryId: 'le-0' },
  });
  const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];
  const byExternal = new Map<string, WagerTransaction>();
  const reversed = new Set<string>();
  let replays = 0;

  const lookup = (tx: WagerTransaction): ReferenceLookup | undefined => {
    if (!tx.referenceExternalTransactionId) return undefined;
    const ref = byExternal.get(tx.referenceExternalTransactionId);
    if (!ref) return { found: false };
    const activeWin = [...byExternal.values()].some(
      (t) =>
        t.kind === WagerTransactionKind.Win &&
        t.status === S.Processed &&
        t.referenceTransactionId === ref.id &&
        !reversed.has(t.id),
    );
    return { found: true, transaction: ref, alreadyReversed: reversed.has(ref.id), settledByWin: tx.isReversal() && activeWin };
  };
  const settle = (tx: WagerTransaction, exhausted: boolean) => {
    const before = wallet.balance;
    const out = settleWager(tx, wallet, lookup(tx), {
      at,
      ledgerEntryId: `le-${++seq}`,
      nextAttemptAt: at,
      referenceRetriesExhausted: exhausted,
    });
    if (out.type === 'processed' && out.entry) {
      expect(out.entry.balanceBefore.equals(before)).toBe(true);
      entries.push(out.entry);
    }
    if (out.type === 'processed' && tx.isReversal()) reversed.add(tx.referenceTransactionId!);
  };
  const retryPending = (exhausted: boolean) => {
    for (const tx of byExternal.values()) if (tx.status === S.PendingReference) settle(tx, exhausted);
  };

  for (const index of delivery) {
    const op = ops[index]!;
    if (byExternal.has(ext(index))) {
      replays++; // idempotent replay: no state change at all
      continue;
    }
    const tx = WagerTransaction.create({
      id: `tx-${index}`,
      providerId: 'provider',
      externalTransactionId: ext(index),
      idempotencyKey: `provider:${ext(index)}`,
      payloadHash: `h-${index}`,
      walletId: 'w',
      playerId: 'p',
      roundId: op.round,
      gameId: 'g',
      kind: op.kind as WagerTransactionKind,
      money: brl(op.amount),
      referenceExternalTransactionId: op.ref === undefined ? undefined : op.ref === -1 ? `ghost-${index}` : ext(op.ref),
      createdAt: at,
    });
    byExternal.set(tx.externalTransactionId, tx);
    settle(tx, false);
    retryPending(false);
  }
  retryPending(true); // retry budget exhausted for whatever still waits
  return { wallet, entries, txs: [...byExternal.values()], replays, opening: brl(opening) };
}

describe('settlement properties (fast-check)', () => {
  test('any history, any order, any duplicates: the financial invariants hold', () => {
    fc.assert(
      fc.property(
        historyArb(1, 30).chain((ops) => fc.tuple(fc.constant(ops), deliveryArb(ops.length), fc.constantFrom('0.00', '10.00', '100.00'))),
        ([ops, delivery, opening]) => {
          const { wallet, entries, txs, replays } = simulate(ops, delivery, opening);

          // 1. balance == Σ ledger, never negative, version == 1 + movements
          const rebuilt = entries.reduce((sum, e) => sum.add(e.signedAmount()), Money.zero('BRL'));
          expect(rebuilt.equals(wallet.balance)).toBe(true);
          expect(wallet.balance.isNegative()).toBe(false);
          expect(wallet.version).toBe(1 + entries.length - (opening === '0.00' ? 0 : 1));
          for (const e of entries) expect(e.isBalanced()).toBe(true);

          // 2. exactly one transaction per external id, duplicates are pure replays
          expect(txs).toHaveLength(ops.length);
          expect(replays).toBe(delivery.length - ops.length);

          // 3. nothing is left pending, and every terminal state is coherent
          for (const tx of txs) {
            expect(tx.isTerminal()).toBe(true);
            const movements = entries.filter((e) => e.transactionId === tx.id);
            if (tx.status === S.Processed) {
              expect(movements).toHaveLength(tx.kind === WagerTransactionKind.Loss ? 0 : 1);
            } else {
              expect(tx.status).toBe(S.Rejected);
              expect(tx.failureCode).toBeDefined();
              expect(movements).toHaveLength(0);
            }
          }

          // 4. reversals: same amount, processed reference, at most one per reference, right direction
          const processedReversals = txs.filter((t) => t.isReversal() && t.status === S.Processed);
          const refs = processedReversals.map((t) => t.referenceTransactionId!);
          expect(new Set(refs).size).toBe(refs.length);
          for (const r of processedReversals) {
            const ref = txs.find((t) => t.id === r.referenceTransactionId)!;
            expect(ref.status).toBe(S.Processed);
            expect(ref.money.equals(r.money)).toBe(true);
            const entry = entries.find((e) => e.transactionId === r.id)!;
            expect(entry.direction).not.toBe(entries.find((e) => e.transactionId === ref.id)!.direction);
          }

          // 5. a BET is never both paid and reversed: a refunded or rolled back BET
          //    has no WIN left standing (a WIN rolled back itself no longer counts)
          for (const bet of txs.filter((t) => t.kind === WagerTransactionKind.Bet)) {
            if (!refs.includes(bet.id)) continue;
            const standingWins = txs.filter(
              (t) => t.kind === WagerTransactionKind.Win && t.status === S.Processed && t.referenceTransactionId === bet.id && !refs.includes(t.id),
            );
            expect(standingWins).toHaveLength(0);
          }

          // 6. a ghost reference always ends REFERENCE_NOT_FOUND
          for (const tx of txs.filter((t) => t.referenceExternalTransactionId?.startsWith('ghost-'))) {
            expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });

  test('credits commute: the final balance of WIN-only histories does not depend on order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 1, maxLength: 40 }).chain((cents) =>
          fc.tuple(fc.constant(cents), fc.shuffledSubarray(cents.map((_, i) => i), { minLength: cents.length, maxLength: cents.length })),
        ),
        ([cents, order]) => {
          const ops: GeneratedOp[] = cents.map((c, index) => ({
            index,
            kind: 'WIN',
            amount: Money.fromMinorUnits(BigInt(c), 'BRL').amount,
            matchRefAmount: false,
            round: 'r1',
          }));
          const inOrder = simulate(ops, ops.map((o) => o.index), '0.00').wallet.balance;
          const shuffled = simulate(ops, order, '0.00').wallet.balance;
          expect(shuffled.equals(inOrder)).toBe(true);
          expect(inOrder.minorUnits).toBe(cents.reduce((a, b) => a + BigInt(b), 0n));
        },
      ),
      { numRuns: 500 },
    );
  });

  test('Money arithmetic is exact for any amounts (no floating-point drift)', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 10n ** 15n }), { maxLength: 50 }), (values) => {
        const total = values.reduce((sum, v) => sum.add(Money.fromMinorUnits(v, 'BRL')), Money.zero('BRL'));
        expect(total.minorUnits).toBe(values.reduce((a, b) => a + b, 0n));
        // round trip through the wire format is lossless
        expect(Money.from(total.toJSON()).equals(total)).toBe(true);
        const back = values.reduce((sum, v) => sum.subtract(Money.fromMinorUnits(v, 'BRL')), total);
        expect(back.isZero()).toBe(true);
      }),
      { numRuns: 1_000 },
    );
  });
});

export { LedgerDirection };
