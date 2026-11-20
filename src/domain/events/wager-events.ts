import type { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { MoneyProps } from '../money/money';
import type { FailureCode } from '../wager/failure-code';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wager/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import { type EventContext, IntegrationEvent } from './integration-event';

interface TransactionEventBase {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function baseOf(tx: WagerTransaction): TransactionEventBase {
  const base: TransactionEventBase = {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
  if (tx.referenceExternalTransactionId) {
    base.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  }
  return base;
}

function props<T>(aggregateId: string, data: T, ctx: EventContext) {
  return { ...ctx, aggregateId, data };
}

// -----------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends TransactionEventBase {
  status: WagerTransactionStatus.Processed;
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

/** Any applied transaction, LOSS included. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const data: WagerTransactionProcessedData = {
      ...baseOf(tx),
      status: tx.status as WagerTransactionStatus.Processed,
      balance: tx.observedBalance!.toJSON(),
      processedAt: tx.processedAt!.toISOString(),
    };
    if (tx.referenceTransactionId) {
      data.referenceTransactionId = tx.referenceTransactionId;
    }
    return new WagerTransactionProcessed(props(tx.walletId, data, ctx));
  }
}

export interface WagerTransactionRejectedData extends TransactionEventBase {
  status: WagerTransactionStatus.Rejected;
  failureCode: FailureCode;
  balance: MoneyProps;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(
      props(
        tx.walletId,
        {
          ...baseOf(tx),
          status: tx.status as WagerTransactionStatus.Rejected,
          failureCode: tx.failureCode!,
          balance: tx.observedBalance!.toJSON(),
          rejectedAt: tx.processedAt!.toISOString(),
        },
        ctx,
      ),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionEventBase {
  status: WagerTransactionStatus.PendingReference;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      props(
        tx.walletId,
        {
          ...baseOf(tx),
          status: tx.status as WagerTransactionStatus.PendingReference,
          nextAttemptAt: tx.nextAttemptAt!.toISOString(),
        },
        ctx,
      ),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Only emitted when the balance actually changes. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      props(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: entry.walletVersion,
        },
        ctx,
      ),
    );
  }
}
