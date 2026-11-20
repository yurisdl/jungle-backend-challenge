import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type { MessageSource, Metrics } from '../../application/ports';

/** Prometheus metrics, exposed on GET /metrics. */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions by final status of the attempt',
    labelNames: ['status', 'kind', 'source'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicates detected (idempotent replays, inbox hits, external id reuse)',
    labelNames: ['source', 'type'],
    registers: [this.registry],
  });
  private readonly idempotencyConflicts = new Counter({
    name: 'wager_idempotency_conflicts_total',
    help: 'Same Idempotency-Key with a different payload',
    labelNames: ['source'],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Retries by operation and reason',
    labelNames: ['operation', 'reason'],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks, serialization failures, version and unique-index races',
    labelNames: ['kind'],
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'sqs_dlq_messages_total',
    help: 'Messages moved to the DLQ',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'End-to-end processing latency of a wager transaction',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Reconciliations where stored balance differs from the ledger',
    registers: [this.registry],
  });

  readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });
  readonly outboxPending = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Unpublished outbox messages',
    registers: [this.registry],
  });
  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Outbox messages published',
    labelNames: ['event_type'],
    registers: [this.registry],
  });
  readonly outboxFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Failed publication attempts',
    registers: [this.registry],
  });
  readonly sqsMessages = new Counter({
    name: 'sqs_messages_total',
    help: 'Queue messages handled by outcome',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  readonly pendingReferences = new Gauge({
    name: 'wager_pending_reference_transactions',
    help: 'Transactions waiting for their reference',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionOutcome(status: string, kind: string, source: MessageSource): void {
    this.transactions.inc({ status, kind, source });
  }
  duplicateDetected(source: MessageSource, type: string): void {
    this.duplicates.inc({ source, type });
  }
  retry(operation: string, reason: string): void {
    this.retries.inc({ operation, reason });
  }
  lockConflict(kind: string): void {
    this.lockConflicts.inc({ kind });
  }
  dlqMessage(reason: string): void {
    this.dlq.inc({ reason });
  }
  processingLatency(source: MessageSource, seconds: number): void {
    this.latency.observe({ source }, seconds);
  }
  reconciliationDivergence(_walletId: string): void {
    this.divergences.inc();
  }
  idempotencyConflict(source: MessageSource): void {
    this.idempotencyConflicts.inc({ source });
  }
}
