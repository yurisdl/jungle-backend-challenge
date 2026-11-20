import type { IntegrationEvent } from '../events/integration-event';
import { InvalidTransactionStateError } from '../shared/errors';

export interface OutboxRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_OUTBOX_RETRY: OutboxRetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  lastError?: string;
}

/**
 * Transactional outbox row. Written in the same SQL transaction as the
 * change that produced the event; a separate worker publishes it.
 * The outbox id is the event id, so a duplicated publication carries the
 * same identity and consumers can de-duplicate.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(payload),
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and computes the next attempt (exponential backoff, capped). */
  scheduleRetry(now: Date, error?: string, policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    const delay = Math.min(policy.baseDelayMs * 2 ** (this._attempts - 1), policy.maxDelayMs);
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._lastError = error?.slice(0, 500);
  }
}
