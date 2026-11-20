import type { AppLogger } from '../../application/ports';
import type { RetryPendingReference } from '../../application/use-cases/retry-pending-reference.use-case';
import type { AppConfig } from '../config/app-config';
import { errorFields } from '../observability/logger';
import type { PrometheusMetrics } from '../observability/metrics';
import { PollingWorker } from './polling-worker';

/**
 * Scheduled worker for out-of-order references. Picks due
 * PENDING_REFERENCE transactions and re-evaluates each one; backoff and the
 * attempt budget live in the use case. Safe with many instances: rows are
 * serialised by the wallet lock and re-checked after it is acquired.
 */
export class PendingReferenceWorker extends PollingWorker {
  constructor(
    private readonly retry: RetryPendingReference,
    private readonly metrics: PrometheusMetrics,
    logger: AppLogger,
    private readonly config: AppConfig,
  ) {
    super('pending-reference', logger, config.pendingReference.pollIntervalMs);
  }

  protected override async tick(): Promise<number> {
    const ids = await this.retry.dueIds(this.config.pendingReference.batchSize);
    let done = 0;
    for (const id of ids) {
      if (!this.isRunning) break;
      try {
        const outcome = await this.retry.execute(id);
        if (outcome === 'processed' || outcome === 'rejected') done++;
      } catch (error) {
        this.logger.warn({ worker: this.name, transactionId: id, ...errorFields(error) }, 'pending reference retry failed');
      }
    }
    this.metrics.pendingReferences.set(ids.length - done);
    return done;
  }
}
