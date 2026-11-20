import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../shared/errors';
import { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  /** internal: opening credit of a wallet */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** accepted, not applied yet (only exists in memory before the first decision) */
  Pending = 'PENDING',
  /** waiting for the referenced transaction */
  PendingReference = 'PENDING_REFERENCE',
  /** applied (terminal) */
  Processed = 'PROCESSED',
  /** business rule violation (terminal) */
  Rejected = 'REJECTED',
  /** permanent infrastructure error (terminal, auditable) */
  Failed = 'FAILED',
}

/** Kinds a provider may submit (OPENING is internal only). */
export const EXTERNAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/** Which kinds each kind may reference. */
const ALLOWED_REFERENCES: Record<WagerTransactionKind, readonly WagerTransactionKind[]> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Valid transitions. Terminal states have no outgoing edges.
 *
 *   PENDING ──────────► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ─► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (re-scheduled)
 */
const TRANSITIONS: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Balance observed when the decision was taken — returned verbatim on replays. */
  observedBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id at the provider — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _attempts: number = 0,
    private _nextAttemptAt?: Date,
  ) {}

  /** Born in PENDING. Validates the reference requirement per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'KIND_NOT_ALLOWED',
        'OPENING is internal; use WagerTransaction.opening()',
      );
    }
    return WagerTransaction.build(props);
  }

  /** Internal opening credit, created together with the wallet. */
  static opening(props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.attempts,
      state.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transitions ----------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = balanceAfter;
    this._nextAttemptAt = undefined;
  }

  /** Reference missing: park the transaction and schedule another attempt. */
  markPendingReference(nextAttemptAt: Date, observedBalance: Money): void {
    if (this._status === WagerTransactionStatus.PendingReference) {
      this._attempts += 1;
    }
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._nextAttemptAt = nextAttemptAt;
    this._observedBalance = observedBalance;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money, referenceTransactionId?: string): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._referenceTransactionId = referenceTransactionId ?? this._referenceTransactionId;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  // ---- domain queries -------------------------------------------------------

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  canReference(kind: WagerTransactionKind): boolean {
    return ALLOWED_REFERENCES[this.kind].includes(kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direction of the ledger line this transaction produces. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError('REFERENCE_REQUIRED', 'ROLLBACK needs its reference');
        }
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('NO_BALANCE_EFFECT', 'LOSS does not move the balance');
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(
        `transaction ${this.id}: ${this._status} → ${next} is not a valid transition`,
      );
    }
    this._status = next;
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const required: Array<keyof CreateWagerTransactionProps> = [
      'id',
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'payloadHash',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ];
    for (const field of required) {
      const value = props[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidWagerTransactionError('INVALID_PAYLOAD', `${field} is required`);
      }
    }
    const tx = new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId || undefined,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
    if (tx.requiresReference() && !tx.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(
        'REFERENCE_REQUIRED',
        `${tx.kind} requires referenceExternalTransactionId`,
      );
    }
    if (tx.referenceExternalTransactionId && ALLOWED_REFERENCES[tx.kind].length === 0) {
      throw new InvalidWagerTransactionError(
        'REFERENCE_NOT_ALLOWED',
        `${tx.kind} cannot reference another transaction`,
      );
    }
    if (tx.referenceExternalTransactionId === tx.externalTransactionId) {
      throw new InvalidWagerTransactionError('INVALID_PAYLOAD', 'a transaction cannot reference itself');
    }
    const zeroAllowed = tx.kind === WagerTransactionKind.Loss;
    if (props.money.isNegative() || (!zeroAllowed && props.money.isZero())) {
      throw new InvalidWagerTransactionError(
        'INVALID_PAYLOAD',
        zeroAllowed ? 'amount cannot be negative' : `${tx.kind} amount must be greater than zero`,
      );
    }
    return tx;
  }
}
