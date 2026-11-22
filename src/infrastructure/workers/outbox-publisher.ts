import { type SendMessageBatchRequestEntry, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
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

/** First key of the outbox advisory locks (the second is the aggregate id hash). */
const OUTBOX_LOCK_SPACE = 0x6f7574; // 'out'

/**
 * Publishes pending outbox rows, in order, per aggregate (wallet).
 *
 * Each batch runs inside one transaction that stays open while it is sent:
 *
 *  1. it picks the aggregates whose OLDEST unpublished event is due and
 *     claims each one with a transaction-scoped advisory lock, so a given
 *     wallet is published by one publisher at a time (any number of
 *     instances can run; a publisher that dies releases its claims by
 *     rolling back);
 *  2. it reads the pending rows of the claimed aggregates in event order;
 *  3. it sends them with at most one message per aggregate in each
 *     `SendMessageBatch`, and stops an aggregate at its first failure, so a
 *     later event never overtakes an earlier one that is waiting for retry.
 *
 * Delivery is at-least-once: a crash between `SendMessageBatch` and `COMMIT`
 * re-sends the same event (same eventId / MessageDeduplicationId), and
 * consumers de-duplicate on eventId.
 */
export class OutboxPublisher extends PollingWorker {
  private lastGaugeUpdate = 0;
  private injectedRejection = false;

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
        const limit = this.config.outbox.batchSize;
        // Aggregates whose oldest unpublished event is due, oldest first. The
        // advisory lock is tried row by row and the LIMIT stops the scan, so
        // aggregates held by another publisher are skipped, not waited for.
        const claimed = await tem.execute<Array<{ aggregate_id: string }>>(
          `with heads as materialized (
             select aggregate_id, occurred_at
               from (select distinct on (aggregate_id) aggregate_id, next_attempt_at, occurred_at
                       from outbox_messages
                      where published_at is null
                      order by aggregate_id, occurred_at, id) h
              where next_attempt_at <= ?
              order by occurred_at
           )
           select aggregate_id from heads
            where pg_try_advisory_xact_lock(${OUTBOX_LOCK_SPACE}, hashtext(aggregate_id::text))
            limit ?`,
          [now, limit],
        );
        if (claimed.length === 0) return 0;

        // Up to `limit` rows of the claimed aggregates, taken round-robin
        // (every claimed aggregate gets its next events before any gets more).
        const picked = await tem.execute<Array<{ id: string }>>(
          `select id from (
             select id, occurred_at,
                    row_number() over (partition by aggregate_id order by occurred_at, id) as position
               from outbox_messages
              where published_at is null and aggregate_id in (?)
           ) t
           order by position, occurred_at, id
           limit ?`,
          [claimed.map((c) => c.aggregate_id), limit],
        );
        const rows = await tem.find(
          OutboxMessageRecord,
          { id: { $in: picked.map((p) => p.id) } },
          { orderBy: { occurredAt: 'asc', id: 'asc' }, disableIdentityMap: true },
        );
        const messages = rows.map(OutboxMapper.toDomain);
        const attempted = await this.sendInOrder(events, messages);
        this.faults.crashIfActive('crash-after-publish');

        for (const m of attempted) {
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
        return attempted.filter((m) => !m.isPending()).length;
      });
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /**
   * Sends rounds of up to 10 messages, one per aggregate per round, in event
   * order. An aggregate whose message fails is left out of the next rounds:
   * its remaining rows stay untouched and go out after the retry.
   * Returns the messages that were attempted.
   */
  private async sendInOrder(queueUrl: string, messages: OutboxMessage[]): Promise<OutboxMessage[]> {
    const lanes = new Map<string, OutboxMessage[]>();
    for (const m of messages) {
      const lane = lanes.get(m.aggregateId);
      if (lane) lane.push(m);
      else lanes.set(m.aggregateId, [m]);
    }
    const attempted: OutboxMessage[] = [];
    for (;;) {
      const round: OutboxMessage[] = [];
      for (const lane of lanes.values()) {
        if (lane.length > 0) round.push(lane[0]!);
        if (round.length === 10) break;
      }
      if (round.length === 0) return attempted;
      await this.sendChunk(queueUrl, round);
      for (const m of round) {
        attempted.push(m);
        const lane = lanes.get(m.aggregateId)!;
        if (m.isPending()) lane.length = 0;
        else lane.shift();
      }
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
      // Test-only: SQS reports the very first entry as failed (it is not sent).
      const injected = this.faults.isActive('reject-first-event') && !this.injectedRejection;
      if (injected) this.injectedRejection = true;
      const toSend = injected ? entries.slice(1) : entries;
      const out =
        toSend.length > 0
          ? await this.sqs.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: toSend }))
          : { Failed: [] };
      const failed = new Map((out.Failed ?? []).map((f) => [f.Id, f.Message ?? f.Code ?? 'failed']));
      if (injected) failed.set('0', 'fault injected: reject-first-event');
      chunk.forEach((m, index) => {
        const reason = failed.get(String(index));
        if (reason) {
          m.scheduleRetry(now, reason, policy);
          this.metrics.outboxFailures.inc();
        } else {
          m.markPublished(now);
          this.metrics.outboxPublished.inc({ event_type: m.eventType });
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
