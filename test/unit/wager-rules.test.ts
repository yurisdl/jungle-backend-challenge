import { describe, expect, test } from 'bun:test';
import {
  FailureCode,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  LedgerDirection,
  Money,
  type ReferenceLookup,
  settleWager,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
  Wallet,
} from '../../src/domain';
import { wagerPayloadHash } from '../../src/application/services/payload-hash';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
let seq = 0;

function wallet(balance = '100.00') {
  return Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl(balance),
    at,
    opening: { transactionId: 'open', ledgerEntryId: 'le-open' },
  }).wallet;
}

function tx(kind: K, amount = '10.00', extra: Partial<{ ref: string; currency: string; round: string; player: string }> = {}) {
  const n = ++seq;
  return WagerTransaction.create({
    id: `tx-${n}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${n}`,
    idempotencyKey: `provider-a:ext-${n}`,
    payloadHash: `hash-${n}`,
    walletId: 'w1',
    playerId: extra.player ?? 'p1',
    roundId: extra.round ?? 'round-1',
    gameId: 'game',
    kind,
    money: Money.from({ amount, currency: extra.currency ?? 'BRL' }),
    referenceExternalTransactionId: extra.ref,
    createdAt: at,
  });
}

const ctx = (exhausted = false) => ({
  at,
  ledgerEntryId: `le-${++seq}`,
  nextAttemptAt: new Date(at.getTime() + 1000),
  referenceRetriesExhausted: exhausted,
});

const found = (t: WagerTransaction, alreadyReversed = false): ReferenceLookup => ({
  found: true,
  transaction: t,
  alreadyReversed,
});

function processedBet(w: Wallet, amount = '10.00') {
  const bet = tx(K.Bet, amount);
  settleWager(bet, w, undefined, ctx());
  expect(bet.status).toBe(S.Processed);
  return bet;
}

describe('WagerTransaction factory', () => {
  test('is born PENDING', () => {
    expect(tx(K.Bet).status).toBe(S.Pending);
  });
  test('OPENING cannot be submitted', () => {
    expect(() => tx(K.Opening)).toThrow(InvalidWagerTransactionError);
  });
  test('REFUND and ROLLBACK require a reference', () => {
    expect(() => tx(K.Refund)).toThrow(InvalidWagerTransactionError);
    expect(() => tx(K.Rollback)).toThrow(InvalidWagerTransactionError);
  });
  test('BET cannot reference another transaction', () => {
    expect(() => tx(K.Bet, '1.00', { ref: 'x' })).toThrow(InvalidWagerTransactionError);
  });
  test('zero amount only for LOSS', () => {
    expect(() => tx(K.Bet, '0.00')).toThrow(InvalidWagerTransactionError);
    expect(tx(K.Loss, '0.00').status).toBe(S.Pending);
  });
  test('terminal states cannot transition', () => {
    const w = wallet();
    const bet = processedBet(w);
    expect(bet.isTerminal()).toBe(true);
    expect(() => bet.reject(FailureCode.InsufficientFunds, at, w.balance)).toThrow(InvalidTransactionStateError);
    expect(() => bet.markProcessed(undefined, at, w.balance)).toThrow(InvalidTransactionStateError);
    expect(() => bet.fail(FailureCode.InternalInvariantViolation, at)).toThrow(InvalidTransactionStateError);
  });
});

describe('BET', () => {
  test('debits and produces one DEBIT entry', () => {
    const w = wallet('100.00');
    const bet = tx(K.Bet, '25.00');
    const out = settleWager(bet, w, undefined, ctx());
    expect(out.type).toBe('processed');
    expect(out.type === 'processed' && out.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('75.00');
    expect(bet.observedBalance?.amount).toBe('75.00');
  });
  test('is rejected with INSUFFICIENT_FUNDS without touching the balance', () => {
    const w = wallet('20.00');
    const bet = tx(K.Bet, '80.00');
    const out = settleWager(bet, w, undefined, ctx());
    expect(out).toEqual({ type: 'rejected', code: FailureCode.InsufficientFunds });
    expect(bet.status).toBe(S.Rejected);
    expect(w.balance.amount).toBe('20.00');
    expect(w.version).toBe(1);
  });
  test('currency conflict is rejected', () => {
    const w = wallet();
    const bet = tx(K.Bet, '1.00', { currency: 'USD' });
    expect(settleWager(bet, w, undefined, ctx())).toEqual({ type: 'rejected', code: FailureCode.CurrencyMismatch });
    expect(w.version).toBe(1);
  });
  test('player not owning the wallet is rejected', () => {
    const w = wallet();
    const bet = tx(K.Bet, '1.00', { player: 'p2' });
    expect(settleWager(bet, w, undefined, ctx())).toEqual({ type: 'rejected', code: FailureCode.PlayerWalletMismatch });
  });
});

describe('WIN', () => {
  test('credits without reference', () => {
    const w = wallet('10.00');
    const out = settleWager(tx(K.Win, '50.00'), w, undefined, ctx());
    expect(out.type === 'processed' && out.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('60.00');
  });
  test('may reference the BET of the same round', () => {
    const w = wallet('10.00');
    const bet = processedBet(w, '10.00');
    const win = tx(K.Win, '30.00', { ref: bet.externalTransactionId });
    settleWager(win, w, found(bet), ctx());
    expect(win.status).toBe(S.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(w.balance.amount).toBe('30.00');
  });
  test('reference from another round is rejected', () => {
    const w = wallet();
    const bet = processedBet(w);
    const win = tx(K.Win, '30.00', { ref: bet.externalTransactionId, round: 'round-2' });
    expect(settleWager(win, w, found(bet), ctx())).toEqual({ type: 'rejected', code: FailureCode.ReferenceMismatch });
  });
});

describe('LOSS', () => {
  test('is processed without balance change and without ledger entry', () => {
    const w = wallet('10.00');
    const loss = tx(K.Loss, '0.00');
    const out = settleWager(loss, w, undefined, ctx());
    expect(out).toEqual({ type: 'processed' });
    expect(loss.status).toBe(S.Processed);
    expect(loss.affectsBalance()).toBe(false);
    expect(w.version).toBe(1);
  });
});

describe('REFUND', () => {
  test('credits back a PROCESSED BET exactly once', () => {
    const w = wallet('100.00');
    const bet = processedBet(w, '40.00');
    const refund = tx(K.Refund, '40.00', { ref: bet.externalTransactionId });
    const out = settleWager(refund, w, found(bet), ctx());
    expect(out.type === 'processed' && out.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('100.00');

    const again = tx(K.Refund, '40.00', { ref: bet.externalTransactionId });
    expect(settleWager(again, w, found(bet, true), ctx())).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceAlreadyReversed,
    });
    expect(w.balance.amount).toBe('100.00');
  });
  test('only references BET', () => {
    const w = wallet();
    const win = tx(K.Win, '5.00');
    settleWager(win, w, undefined, ctx());
    const refund = tx(K.Refund, '5.00', { ref: win.externalTransactionId });
    expect(settleWager(refund, w, found(win), ctx())).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceKindNotAllowed,
    });
  });
  test('amount must equal the reference (no partial reversal)', () => {
    const w = wallet();
    const bet = processedBet(w, '10.00');
    const refund = tx(K.Refund, '5.00', { ref: bet.externalTransactionId });
    expect(settleWager(refund, w, found(bet), ctx())).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceAmountMismatch,
    });
  });
  test('cannot refund a REJECTED bet', () => {
    const w = wallet('1.00');
    const bet = tx(K.Bet, '10.00');
    settleWager(bet, w, undefined, ctx());
    expect(bet.status).toBe(S.Rejected);
    const refund = tx(K.Refund, '10.00', { ref: bet.externalTransactionId });
    expect(settleWager(refund, w, found(bet), ctx())).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceNotProcessed,
    });
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits', () => {
    const w = wallet('100.00');
    const bet = processedBet(w, '30.00');
    const rb = tx(K.Rollback, '30.00', { ref: bet.externalTransactionId });
    const out = settleWager(rb, w, found(bet), ctx());
    expect(out.type === 'processed' && out.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('100.00');
  });
  test('of a WIN debits', () => {
    const w = wallet('0.00');
    const win = tx(K.Win, '30.00');
    settleWager(win, w, undefined, ctx());
    const rb = tx(K.Rollback, '30.00', { ref: win.externalTransactionId });
    const out = settleWager(rb, w, found(win), ctx());
    expect(out.type === 'processed' && out.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('0.00');
  });
  test('that would make the balance negative is rejected with a distinct code', () => {
    const w = wallet('0.00');
    const win = tx(K.Win, '30.00');
    settleWager(win, w, undefined, ctx());
    w.debit({ transactionId: 'spent', ledgerEntryId: 'le-spent', money: brl('20.00'), at });
    const rb = tx(K.Rollback, '30.00', { ref: win.externalTransactionId });
    const out = settleWager(rb, w, found(win), ctx());
    expect(out).toEqual({ type: 'rejected', code: FailureCode.ReversalInsufficientFunds });
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(rb.status).toBe(S.Rejected);
    expect(w.balance.amount).toBe('10.00');
  });
  test('cannot reference LOSS or another ROLLBACK', () => {
    const w = wallet();
    const loss = tx(K.Loss, '0.00');
    settleWager(loss, w, undefined, ctx());
    const rb = tx(K.Rollback, '1.00', { ref: loss.externalTransactionId });
    expect(settleWager(rb, w, found(loss), ctx())).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceKindNotAllowed,
    });
  });
  test('arriving before its reference goes to PENDING_REFERENCE, then REJECTED when exhausted', () => {
    const w = wallet();
    const rb = tx(K.Rollback, '10.00', { ref: 'not-yet' });
    expect(settleWager(rb, w, { found: false }, ctx())).toEqual({ type: 'pending-reference', firstTime: true });
    expect(rb.status).toBe(S.PendingReference);
    expect(rb.attempts).toBe(0);
    expect(settleWager(rb, w, { found: false }, ctx())).toEqual({ type: 'pending-reference', firstTime: false });
    expect(rb.attempts).toBe(1);
    expect(settleWager(rb, w, { found: false }, ctx(true))).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceNotFound,
    });
    expect(rb.isTerminal()).toBe(true);
  });
  test('pending rollback is applied once the reference shows up', () => {
    const w = wallet('100.00');
    const rb = tx(K.Rollback, '10.00', { ref: 'later-bet' });
    settleWager(rb, w, { found: false }, ctx());
    const bet = processedBet(w, '10.00');
    settleWager(rb, w, found(bet), ctx());
    expect(rb.status).toBe(S.Processed);
    expect(w.balance.amount).toBe('100.00');
  });
});

describe('payload hash', () => {
  const base = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'p',
    walletId: 'w',
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  test('does not depend on key order', () => {
    const reordered = Object.fromEntries(
      Object.entries({ ...base, money: { currency: 'BRL', amount: '25.00' } }).reverse(),
    ) as typeof base;
    expect(Object.keys(reordered)[0]).toBe('money');
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(base));
  });
  test('diverging payload with the same idempotency key produces a different hash', () => {
    expect(wagerPayloadHash({ ...base, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(
      wagerPayloadHash(base),
    );
    const t = tx(K.Bet);
    expect(t.matchesPayload(t.payloadHash)).toBe(true);
    expect(t.matchesPayload('something-else')).toBe(false);
  });
});
