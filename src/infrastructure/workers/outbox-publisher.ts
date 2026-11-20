import { type SendMessageBatchRequestEntry, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { AppLogger, Clock } from '../../application/ports';
import type { OutboxMessage } from '../../domain';
import type { AppConfig } from '../config/app-config';
import { errorFields } from '../observability/logger';
import type { PrometheusMetrics } from '../observability/metrics';
import { translateDbError } from '../persistence/db-errors';
import { OutboxMapper } from '../persistence/mappers';
import { OutboxMessageRecord } from '../persistence/schemas/records';
import type { QueueRegistry } from '../sqs/sqs';
import type { FaultInjector } from './faults';
import { PollingWorker } from './polling-worker';

/**
 * Publishes pending outbox rows.
 *
 * Each batch is claimed with `SELECT … FOR UPDATE SKIP LOCKED` inside a
 * transaction that stays open while the batch is sent, so concurrent
 * publishers (any number of instances) never pick the same row, and a
 * publisher that dies releases its rows by rolling back. Delivery is
 * at-least-once: a crash between `SendMessageBatch` and `COMMIT` re-sends
 * the same event (same eventId / MessageDeduplicationId) — consumers
 * de-duplicate on eventId.
 */
export class OutboxPublisher extends PollingWorker {
  private lastGaugeUpdate = 0;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queues: QueueRegistry,
    private readonly clock: Clock,
    private readonly metrics: PrometheusMetrics,
    logger: AppLogger,
    private readonly config: AppConfig,
    private readonly faults: FaultInjector,
  ) {
    super('outbox-publisher', logger, config.outbox.pollIntervalMs);
  }

  protected override async tick(): Promise<number> {
    await this.updateGauges();
    return this.publishBatch();
  }

  /** Claims and publishes one batch. Exposed for tests. */
  async publishBatch(): Promise<number> {
    const { events } = await this.queues.resolve();
    const em = this.orm.em.fork({ clear: true, useContext: false });
    try {
      return await em.transactional(async (tem) => {
        const now = this.clock.now();
        const rows = await tem.find(
          OutboxMessageRecord,
          { publishedAt: null, nextAttemptAt: { $lte: now } },
          {
            orderBy: { occurredAt: 'asc', id: 'asc' },
            limit: this.config.outbox.batchSize,
            lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
            disableIdentityMap: true,
          },
        );
        if (rows.length === 0) return 0;
        const messages = rows.map(OutboxMapper.toDomain);

        for (let i = 0; i < messages.length; i += 10) {
          await this.sendChunk(events, messages.slice(i, i + 10));
        }
        this.faults.crashIfActive('crash-after-publish');

        for (const m of messages) {
          await tem.nativeUpdate(
            OutboxMessageRecord,
            { id: m.id },
            {
              attempts: m.attempts,
              nextAttemptAt: m.nextAttemptAt ?? null,
              publishedAt: m.publishedAt ?? null,
              lastError: m.lastError ?? null,
            },
          );
        }
        return messages.filter((m) => !m.isPending()).length;
      });
    } catch (error) {
      throw translateDbError(error);
    }
  }

  private async sendChunk(queueUrl: string, chunk: OutboxMessage[]): Promise<void> {
    const now = this.clock.now();
    const policy = { baseDelayMs: this.config.outbox.retryBaseMs, maxDelayMs: this.config.outbox.retryMaxMs };
    const entries: SendMessageBatchRequestEntry[] = chunk.map((m, index) => ({
      Id: String(index),
      MessageBody: JSON.stringify(m.payload),
      MessageGroupId: m.aggregateId,
      MessageDeduplicationId: m.id,
      MessageAttributes: {
        eventType: { DataType: 'String', StringValue: m.eventType },
        eventId: { DataType: 'String', StringValue: m.id },
      },
    }));
    try {
      if (this.faults.isActive('fail-publish')) throw new Error('fault injected: fail-publish');
      const out = await this.sqs.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }));
      const failed = new Map((out.Failed ?? []).map((f) => [f.Id, f.Message ?? f.Code ?? 'failed']));
      chunk.forEach((m, index) => {
        const reason = failed.get(String(index));
        if (reason) {
          m.scheduleRetry(now, reason, policy);
          this.metrics.outboxFailures.inc();
        } else {
          m.markPublished(now);
          this.metrics.outboxPublished.inc({ event_type: m.eventType });
          this.metrics.outboxLag.set(0);
        }
      });
    } catch (error) {
      this.logger.warn({ worker: this.name, count: chunk.length, ...errorFields(error) }, 'outbox publication failed');
      for (const m of chunk) {
        m.scheduleRetry(now, error instanceof Error ? error.message : String(error), policy);
        this.metrics.outboxFailures.inc();
        this.metrics.retry('outbox-publish', 'sqs-error');
      }
    }
  }

  private async updateGauges(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastGaugeUpdate < 5_000) return;
    this.lastGaugeUpdate = nowMs;
    const em = this.orm.em.fork({ clear: true, useContext: false });
    const rows = await em.execute<Array<{ pending: number; oldest: Date | null }>>(
      `select count(*)::int as pending, min(occurred_at) as oldest from outbox_messages where published_at is null`,
    );
    const row = rows[0];
    this.metrics.outboxPending.set(row?.pending ?? 0);
    const oldest = row?.oldest ? new Date(row.oldest).getTime() : undefined;
    this.metrics.outboxLag.set(oldest ? Math.max(0, (nowMs - oldest) / 1000) : 0);
  }
}
