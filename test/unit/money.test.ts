import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../src/domain';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('parses and always serializes with scale 2', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25.5').amount).toBe('25.50');
    expect(brl('0.01').amount).toBe('0.01');
    expect(brl('1000.00').toString()).toBe('1000.00 BRL');
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1E-2'],
    [''],
    [' 1.00'],
    ['1.00 '],
    ['1.001'],
    ['0.999'],
    ['-1.00'],
    ['+1.00'],
    ['01.00'],
    ['1.'],
    ['.50'],
    ['1,00'],
    ['0x10'],
    ['12345678901234567.00'],
  ])('rejects invalid amount %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects non-string amounts (numbers are never accepted for money)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each([['brl'], ['BR'], ['BRLL'], [''], ['12A']])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('arithmetic is exact (no floating point drift, no rounding)', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 10; i++) total = total.add(brl('0.10'));
    expect(total.amount).toBe('1.00');
    expect(brl('0.30').subtract(brl('0.10')).amount).toBe('0.20');
    expect(brl('9999999999999999.99').add(brl('0.01')).amount).toBe('10000000000000000.00');
  });

  test('is immutable', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
    expect(a.negate().amount).toBe('-10.00');
    expect(a.amount).toBe('10.00');
  });

  test('comparisons', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.01'))).toBe(false);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  test('operations across currencies throw a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});
