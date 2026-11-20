/**
 * Application-level errors. Each category maps to exactly one HTTP status
 * and one SQS handling strategy (see interfaces/http/error-mapping.ts and
 * infrastructure/sqs/wager-consumer.ts).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed payload / missing header. Do not retry as is. */
export class ValidationError extends ApplicationError {
  constructor(
    readonly code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}

/** Same idempotency key, different payload. Never a replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
}

/** (providerId, externalTransactionId) already used under another idempotency key. */
export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

/** A path resource does not exist. */
export class ResourceNotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';
}

/** The wallet referenced in a transaction body does not exist. */
export class UnknownWalletError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
}

/** Temporary infrastructure problem: the same request can be retried. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_ERROR';

  constructor(
    readonly reason: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, { reason });
  }
}

export type ConflictKind = 'deadlock' | 'serialization' | 'version' | 'unique-race';

/**
 * Concurrency conflict detected by the database (deadlock, serialization
 * failure, lost-update guard, unique-index race). The whole transaction is
 * safe to re-run: the use cases retry it a bounded number of times.
 */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = 'CONCURRENCY_CONFLICT';

  constructor(
    readonly kind: ConflictKind,
    message: string,
    readonly constraint?: string,
    override readonly cause?: unknown,
  ) {
    super(message, { kind, constraint });
  }
}

/** A database invariant rejected the write: a bug, never a business outcome. */
export class InvariantViolationError extends ApplicationError {
  readonly code = 'INTERNAL_INVARIANT_VIOLATION';

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
