/**
 * Stable, machine-readable failure taxonomy. The value tells a provider
 * what to do next:
 *
 *  - `retryable: false, fix: true`  → correct the payload / reference and send a NEW transaction;
 *  - `retryable: false, fix: false` → give up, the outcome is final;
 *  - `retryable: true`              → the same request may be retried as is.
 *
 * Persisted rejections (status REJECTED) and infrastructure failures
 * (status FAILED) use these codes. See ARCHITECTURE.md §Failure codes.
 */
export enum FailureCode {
  // ---- business rejections (REJECTED, terminal)
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReferenceAlreadySettled = 'REFERENCE_ALREADY_SETTLED',

  // ---- permanent infrastructure failures (FAILED, terminal, auditable)
  ProcessingRetriesExhausted = 'PROCESSING_RETRIES_EXHAUSTED',
  InternalInvariantViolation = 'INTERNAL_INVARIANT_VIOLATION',
}

export const FAILURE_CODES = Object.values(FailureCode) as string[];

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === 'string' && FAILURE_CODES.includes(value);
}
