import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import type { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

/** What the persistence layer found for `referenceExternalTransactionId`. */
export type ReferenceLookup =
  | { found: false }
  | {
      found: true;
      transaction: WagerTransaction;
      /** another REFUND/ROLLBACK already PROCESSED against this reference */
      alreadyReversed: boolean;
    };

export interface SettlementContext {
  at: Date;
  ledgerEntryId: string;
  /** when to try again if the reference is still missing */
  nextAttemptAt: Date;
  /** retry budget for missing references exhausted → reject */
  referenceRetriesExhausted: boolean;
}

export type SettlementOutcome =
  | { type: 'processed'; entry?: WalletLedgerEntry }
  | { type: 'rejected'; code: FailureCode }
  | { type: 'pending-reference'; firstTime: boolean };

/**
 * Domain service that decides and applies one wager transaction against
 * its (already locked) wallet. Pure: no I/O, mutates only the aggregates
 * it receives, so every business rule is unit-testable.
 */
export function settleWager(
  tx: WagerTransaction,
  wallet: Wallet,
  reference: ReferenceLookup | undefined,
  ctx: SettlementContext,
): SettlementOutcome {
  const reject = (code: FailureCode, referenceId?: string): SettlementOutcome => {
    tx.reject(code, ctx.at, wallet.balance, referenceId);
    return { type: 'rejected', code };
  };

  if (wallet.id !== tx.walletId || wallet.playerId !== tx.playerId) {
    return reject(FailureCode.PlayerWalletMismatch);
  }
  if (wallet.currency !== tx.money.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  let ref: WagerTransaction | undefined;
  if (tx.referenceExternalTransactionId) {
    if (!reference || !reference.found) {
      if (ctx.referenceRetriesExhausted) {
        return reject(FailureCode.ReferenceNotFound);
      }
      const firstTime = tx.status !== WagerTransactionStatus.PendingReference;
      tx.markPendingReference(ctx.nextAttemptAt, wallet.balance);
      return { type: 'pending-reference', firstTime };
    }
    ref = reference.transaction;
    if (
      ref.providerId !== tx.providerId ||
      ref.playerId !== tx.playerId ||
      ref.walletId !== tx.walletId ||
      ref.money.currency !== tx.money.currency ||
      ref.roundId !== tx.roundId
    ) {
      return reject(FailureCode.ReferenceMismatch, ref.id);
    }
    if (!tx.canReference(ref.kind)) {
      return reject(FailureCode.ReferenceKindNotAllowed, ref.id);
    }
    if (ref.status === WagerTransactionStatus.PendingReference) {
      // The reference itself waits for its own reference: keep waiting.
      if (ctx.referenceRetriesExhausted) {
        return reject(FailureCode.ReferenceNotProcessed, ref.id);
      }
      const firstTime = tx.status !== WagerTransactionStatus.PendingReference;
      tx.markPendingReference(ctx.nextAttemptAt, wallet.balance);
      return { type: 'pending-reference', firstTime };
    }
    if (ref.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed, ref.id);
    }
    if (tx.isReversal()) {
      if (!ref.money.equals(tx.money)) {
        return reject(FailureCode.ReferenceAmountMismatch, ref.id);
      }
      if (reference.alreadyReversed) {
        return reject(FailureCode.ReferenceAlreadyReversed, ref.id);
      }
    }
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(ref?.id, ctx.at, wallet.balance);
    return { type: 'processed' };
  }

  const direction = tx.ledgerDirectionFor(ref);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    return reject(
      tx.kind === WagerTransactionKind.Rollback
        ? FailureCode.ReversalInsufficientFunds
        : FailureCode.InsufficientFunds,
      ref?.id,
    );
  }
  const entry = wallet.apply(direction, {
    transactionId: tx.id,
    ledgerEntryId: ctx.ledgerEntryId,
    money: tx.money,
    at: ctx.at,
  });
  tx.markProcessed(ref?.id, ctx.at, wallet.balance);
  return { type: 'processed', entry };
}
