import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money, type MoneyProps } from '../money/money';
import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from '../shared/errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Ids used for the internal OPENING movement when initialBalance > 0. */
  opening: { transactionId: string; ledgerEntryId: string };
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Present only when the initial balance is greater than zero. */
  openingEntry?: WalletLedgerEntry;
}

export interface BalanceMovement {
  transactionId: string;
  ledgerEntryId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. Every balance change goes through `debit`/`credit`,
 * which return the matching ledger entry, so balance and ledger can never
 * drift apart inside the model. `version` starts at 1 and is incremented
 * only when the balance changes.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('initial balance cannot be negative');
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
    if (props.initialBalance.isZero()) {
      return { wallet };
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.ledgerEntryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: props.initialBalance,
      walletVersion: 1,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — does not re-validate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(
        `wallet ${this.id} has ${this._balance}, cannot debit ${movement.money}`,
      );
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvalidWalletError('movement amount must be positive');
    }
    const before = this._balance;
    const after =
      direction === LedgerDirection.Credit ? before.add(movement.money) : before.subtract(movement.money);
    if (after.isNegative()) {
      throw new InsufficientFundsError(`wallet ${this.id} would become negative`);
    }
    const entry = WalletLedgerEntry.create({
      id: movement.ledgerEntryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  toJSON(): { id: string; playerId: string; balance: MoneyProps; version: number } {
    return {
      id: this.id,
      playerId: this.playerId,
      balance: this._balance.toJSON(),
      version: this._version,
    };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
