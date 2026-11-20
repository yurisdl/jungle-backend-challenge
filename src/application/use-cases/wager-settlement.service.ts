import {
  type EventContext,
  type IntegrationEvent,
  type MoneyProps,
  OutboxMessage,
  type ReferenceLookup,
  type SettlementOutcome,
  type WagerTransaction,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  type Wallet,
  WalletBalanceChanged,
} from '../../domain';
import type { IdGenerator, TransactionalStore } from '../ports';

export interface WagerResultView {
  transactionId: string;
  status: string;
  balance: MoneyProps | null;
  failureCode?: string;
  referenceTransactionId?: string;
  idempotentReplay: boolean;
}

export function toResultView(tx: WagerTransaction, idempotentReplay: boolean): WagerResultView {
  const view: WagerResultView = {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.observedBalance && tx.observedBalance.currency === tx.money.currency ? tx.observedBalance.toJSON() : null,
    idempotentReplay,
  };
  if (tx.failureCode) view.failureCode = tx.failureCode;
  if (tx.referenceTransactionId) view.referenceTransactionId = tx.referenceTransactionId;
  return view;
}

export interface CausalContext {
  correlationId: string;
  causationId?: string;
}

export interface ReferenceRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export function nextReferenceAttempt(policy: ReferenceRetryPolicy, at: Date, attempts: number): Date {
  const delay = Math.min(policy.baseDelayMs * 2 ** attempts, policy.maxDelayMs);
  return new Date(at.getTime() + delay);
}

/** Persistence side of a settlement — shared by the submit and the retry use cases. */
export class WagerSettlementWriter {
  constructor(private readonly ids: IdGenerator) {}

  async lookupReference(store: TransactionalStore, tx: WagerTransaction): Promise<ReferenceLookup | undefined> {
    if (!tx.referenceExternalTransactionId) return undefined;
    const ref = await store.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
    if (!ref) return { found: false };
    const alreadyReversed = tx.isReversal() ? await store.transactions.hasProcessedReversal(ref.id) : false;
    return { found: true, transaction: ref, alreadyReversed };
  }

  /**
   * Writes the wallet (conditional on its previous version), the ledger
   * entry and the integration events. Must run inside the same SQL
   * transaction that inserted/updated `tx`.
   */
  async persistOutcome(
    store: TransactionalStore,
    tx: WagerTransaction,
    wallet: Wallet,
    previousWalletVersion: number,
    outcome: SettlementOutcome,
    causal: CausalContext,
    at: Date,
  ): Promise<void> {
    const events: IntegrationEvent<unknown>[] = [];
    const ctx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: causal.correlationId,
      causationId: causal.causationId,
      occurredAt: at,
    });

    switch (outcome.type) {
      case 'processed':
        if (outcome.entry) {
          await store.wallets.updateBalance(wallet, previousWalletVersion);
          await store.ledger.insert(outcome.entry);
          events.push(WalletBalanceChanged.from(wallet, outcome.entry, ctx()));
        }
        events.push(WagerTransactionProcessed.from(tx, ctx()));
        await store.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, at);
        break;
      case 'rejected':
        events.push(WagerTransactionRejected.from(tx, ctx()));
        break;
      case 'pending-reference':
        if (outcome.firstTime) {
          events.push(WagerTransactionPendingReference.from(tx, ctx()));
        }
        break;
    }
    await store.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
  }
}
