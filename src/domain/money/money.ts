import { CurrencyMismatchError, InvalidMoneyError } from '../shared/errors';

/** Wire / persistence contract — amount is always a decimal string. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
/** numeric(18,2) in PostgreSQL: at most 16 integer digits. */
const MAX_INTEGER_DIGITS = 16;
const AMOUNT_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable monetary value with a fixed scale of 2.
 *
 * Internally the amount is kept as an integer count of minor units
 * (`bigint`), so every operation is exact: there is no floating point and
 * no rounding anywhere. Inputs with more than 2 decimal places are
 * rejected instead of being rounded.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /**
   * Parses a contract value. Rejects NaN, Infinity, scientific notation,
   * empty strings, signs, whitespace, more than 2 decimals and negatives.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money must be an object with amount and currency');
    }
    const currency = Money.parseCurrency(props.currency);
    return new Money(Money.parseAmount(props.amount), currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  /** Builds a value from minor units (cents). Internal use: persistence and arithmetic. */
  static fromMinorUnits(minor: bigint, currency: string): Money {
    return new Money(minor, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  get minorUnits(): bigint {
    return this.minor;
  }

  /** Decimal string with exactly 2 places, e.g. "25.00", "-0.50". */
  get amount(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const integer = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${integer.toString()}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code (3 uppercase letters)');
    }
    return currency;
  }

  private static parseAmount(amount: unknown): bigint {
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    const match = AMOUNT_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(
        `amount "${amount}" is not a non-negative decimal with at most ${SCALE} places`,
      );
    }
    const integerPart = match[1] ?? '0';
    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError(`amount exceeds ${MAX_INTEGER_DIGITS} integer digits`);
    }
    const fractionPart = (match[2] ?? '').padEnd(SCALE, '0');
    return BigInt(integerPart) * FACTOR + BigInt(fractionPart);
  }
}
