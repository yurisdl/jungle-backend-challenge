import {
  ApplicationError,
  ConcurrencyConflictError,
  InvariantViolationError,
  TransientInfrastructureError,
} from '../../application/errors';
import { DomainError } from '../../domain';

interface PgLikeError {
  code?: string;
  constraint?: string;
  message?: string;
  cause?: unknown;
}

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN']);
const CONNECTION_MESSAGES = [
  'Connection terminated',
  'Timeout acquiring a connection',
  'connect ECONNREFUSED',
  'Client has encountered a connection error',
  'the database system is',
  'terminating connection',
  'Connection ended',
  'Unable to connect',
];

function find(error: unknown): PgLikeError | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as PgLikeError;
    if (typeof e.code === 'string') return e;
    current = e.cause;
  }
  return error && typeof error === 'object' ? (error as PgLikeError) : undefined;
}

/**
 * Translates driver / PostgreSQL errors into application error categories:
 *  - concurrency conflicts (re-run the transaction),
 *  - transient infrastructure errors (retry later),
 *  - invariant violations (a bug: the schema refused an impossible state).
 */
export function translateDbError(error: unknown): unknown {
  if (error instanceof ApplicationError || error instanceof DomainError) return error;
  const e = find(error);
  const code = e?.code ?? '';
  const message = e?.message ?? String(error);

  switch (code) {
    case '40001':
      return new ConcurrencyConflictError('serialization', 'serialization failure', undefined, error);
    case '40P01':
      return new ConcurrencyConflictError('deadlock', 'deadlock detected', undefined, error);
    case '23505':
      return new ConcurrencyConflictError('unique-race', `unique violation on ${e?.constraint}`, e?.constraint, error);
    case '55P03':
      return new TransientInfrastructureError('LOCK_TIMEOUT', 'timed out waiting for a row lock', error);
    case '57014':
      return new TransientInfrastructureError('STATEMENT_TIMEOUT', 'statement timeout', error);
    case '53300':
      return new TransientInfrastructureError('DATABASE_UNAVAILABLE', 'too many connections', error);
    case '23514':
    case '23503':
    case '23502':
    case 'P0001':
      return new InvariantViolationError(`database invariant violated: ${message}`, error);
  }
  if (code.startsWith('08') || code.startsWith('57P') || CONNECTION_CODES.has(code)) {
    return new TransientInfrastructureError('DATABASE_UNAVAILABLE', 'database unavailable', error);
  }
  if (CONNECTION_MESSAGES.some((m) => message.includes(m))) {
    return new TransientInfrastructureError('DATABASE_UNAVAILABLE', 'database unavailable', error);
  }
  return error;
}
