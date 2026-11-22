import { FailureCode, settleWager, WagerTransactionStatus } from '../../domain';
import type { AppLogger, Clock, IdGenerator, Metrics, UnitOfWork } from '../ports';
import { withConflictRetry } from '../services/conflict-retry';
import { nextReferenceAttempt, type ReferenceRetryPolicy, WagerSettlementWriter } from './wager-settlement.service';

export type RetryOutcome = 'processed' | 'rejected' | 'still-pending' | 'skipped';

/**
 * Re-evaluates a PENDING_REFERENCE transaction. Lock order is always
 * wallet → transaction (same as the submit path) so concurrent workers and
 * submissions cannot deadlock; whoever comes second re-reads the row and
 * skips it when it is no longer due.
 */
export class RetryPendingReference {
  private readonly writer: WagerSettlementWriter;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly policy: ReferenceRetryPolicy,
  ) {
    this.writer = new WagerSettlementWriter(ids);
  }

  async dueIds(limit: number): Promise<string[]> {
    return this.uow.transaction((store) => store.transactions.findDuePendingReferenceIds(this.clock.now(), limit), {
      readOnly: true,
    });
  }

  /** Every transaction still waiting for its reference, due or not (for the gauge). */
  async countPending(): Promise<number> {
    return this.uow.transaction((store) => store.transactions.countPendingReferences(), { readOnly: true });
  }

  async execute(transactionId: string): Promise<RetryOutcome> {
    const outcome = await withConflictRetry(this.metrics, { operation: 'retry-pending-reference' }, () =>
      this.uow.transaction(async (store) => {
        const peek = await store.transactions.findById(transactionId);
        if (!peek || peek.status !== WagerTransactionStatus.PendingReference) return 'skipped' as const;

        const wallet = await store.wallets.lockById(peek.walletId);
        const tx = await store.transactions.lockById(transactionId);
        const now = this.clock.now();
        if (
          !wallet ||
          !tx ||
          tx.status !== WagerTransactionStatus.PendingReference ||
          (tx.nextAttemptAt && tx.nextAttemptAt.getTime() > now.getTime())
        ) {
          return 'skipped' as const;
        }

        const previousVersion = wallet.version;
        const reference = await this.writer.lookupReference(store, tx);
        const attemptsAfterThis = tx.attempts + 1;
        const result = settleWager(tx, wallet, reference, {
          at: now,
          ledgerEntryId: this.ids.next(),
          nextAttemptAt: nextReferenceAttempt(this.policy, now, attemptsAfterThis),
          referenceRetriesExhausted: attemptsAfterThis >= this.policy.maxAttempts,
        });
        await store.transactions.update(tx, now);
        await this.writer.persistOutcome(
          store,
          tx,
          wallet,
          previousVersion,
          result,
          { correlationId: tx.idempotencyKey, causationId: tx.id },
          now,
        );
        this.logger.info(
          {
            transactionId: tx.id,
            walletId: tx.walletId,
            providerId: tx.providerId,
            attempts: tx.attempts,
            status: tx.status,
            failureCode: tx.failureCode,
          },
          'pending reference re-evaluated',
        );
        if (result.type === 'pending-reference') return 'still-pending' as const;
        this.metrics.transactionOutcome(tx.status, tx.kind, 'worker');
        return result.type;
      }),
    );
    if (outcome === 'still-pending') this.metrics.retry('pending-reference', 'reference-missing');
    return outcome;
  }

  /**
   * Called when re-evaluating a transaction threw (lock timeout, invariant
   * violation, a bug). Counts the attempt and pushes the next one back, so a
   * transaction that keeps failing cannot stay at the head of the queue and
   * starve the others. Once the attempt budget is spent it ends FAILED
   * (PROCESSING_RETRIES_EXHAUSTED): no balance, ledger or event is touched.
   */
  async postpone(transactionId: string): Promise<'postponed' | 'failed' | 'skipped'> {
    return this.uow.transaction(async (store) => {
      const tx = await store.transactions.lockById(transactionId);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return 'skipped' as const;
      const now = this.clock.now();
      const attemptsAfterThis = tx.attempts + 1;
      if (attemptsAfterThis >= this.policy.maxAttempts) {
        tx.fail(FailureCode.ProcessingRetriesExhausted, now);
        await store.transactions.update(tx, now);
        await store.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, now);
        this.metrics.transactionOutcome(tx.status, tx.kind, 'worker');
        this.logger.error(
          { transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId, attempts: attemptsAfterThis },
          'pending reference kept failing, recorded as FAILED',
        );
        return 'failed' as const;
      }
      tx.postponeAfterFailure(nextReferenceAttempt(this.policy, now, attemptsAfterThis));
      await store.transactions.update(tx, now);
      this.metrics.retry('pending-reference', 'processing-error');
      return 'postponed' as const;
    });
  }
}
