import { ConcurrencyConflictError } from '../errors';
import type { Metrics } from '../ports';

export interface ConflictRetryOptions {
  operation: string;
  maxAttempts?: number;
  /** extra predicate: return false to surface a conflict immediately */
  retryable?: (error: ConcurrencyConflictError) => boolean;
}

/**
 * Re-runs a whole transaction after a concurrency conflict. Bounded, with a
 * small randomised backoff so competing instances do not retry in lockstep.
 */
export async function withConflictRetry<T>(
  metrics: Metrics,
  options: ConflictRetryOptions,
  work: () => Promise<T>,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ConcurrencyConflictError)) throw error;
      if (options.retryable && !options.retryable(error)) throw error;
      metrics.lockConflict(error.kind);
      if (attempt >= maxAttempts) throw error;
      metrics.retry(options.operation, error.kind);
      const delay = Math.min(5 * 2 ** attempt, 100) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
