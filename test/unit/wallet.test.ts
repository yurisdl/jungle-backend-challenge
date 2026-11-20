import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  LedgerDirection,
  Money,
  Wallet,
  WalletLedgerEntry,
} from '../../src/domain';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
let seq = 0;
const ids = () => ({ transactionId: `tx-${++seq}`, ledgerEntryId: `le-${seq}` });

function open(initial: string) {
  return Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), at, opening: ids() });
}

describe('Wallet', () => {
  test('opens with version 1 and an OPENING credit when balance > 0', () => {
    const { wallet, openingEntry } = open('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('100.00');
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('opens without ledger entry when balance is zero', () => {
    const { wallet, openingEntry } = open('0.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('debit and credit produce consistent ledger entries and bump the version', () => {
    const { wallet } = open('100.00');
    const debit = wallet.debit({ ...ids(), money: brl('80.00'), at });
    expect(debit.balanceBefore.amount).toBe('100.00');
    expect(debit.balanceAfter.amount).toBe('20.00');
    expect(debit.walletVersion).toBe(2);
    expect(wallet.version).toBe(2);
    const credit = wallet.credit({ ...ids(), money: brl('5.50'), at });
    expect(credit.balanceAfter.amount).toBe('25.50');
    expect(wallet.version).toBe(3);
    expect(wallet.balance.amount).toBe('25.50');
  });

  test('never goes negative', () => {
    const { wallet } = open('10.00');
    expect(() => wallet.debit({ ...ids(), money: brl('10.01'), at })).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(1);
    wallet.debit({ ...ids(), money: brl('10.00'), at });
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rejects operations in another currency', () => {
    const { wallet } = open('10.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.credit({ ...ids(), money: usd, at })).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit({ ...ids(), money: usd, at })).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('ledger entry validates its arithmetic and is frozen', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'x',
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('95.00'),
        walletVersion: 2,
        createdAt: at,
      }),
    ).toThrow(InvalidLedgerEntryError);
    const entry = WalletLedgerEntry.create({
      id: 'x',
      walletId: 'w',
      transactionId: 't',
      direction: LedgerDirection.Debit,
      money: brl('10.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('90.00'),
      walletVersion: 2,
      createdAt: at,
    });
    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = 'CREDIT';
    }).toThrow();
  });
});
