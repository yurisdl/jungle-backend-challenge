import type {
  InboxMessage,
  Money,
  OutboxMessage,
  WagerTransaction,
  Wallet,
  WalletLedgerEntry,
} from '../../domain';

export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');
export const UNIT_OF_WORK = Symbol('UnitOfWork');
export const METRICS = Symbol('Metrics');
export const APP_LOGGER = Symbol('AppLogger');

export interface Clock {
  now(): Date;
}

/** Time-ordered ids (UUIDv7) keep B-tree inserts sequential. */
export interface IdGenerator {
  next(): string;
}

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** `SELECT … FOR UPDATE` on this wallet row only (the unit of concurrency). */
  lockById(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /** Conditional update (`WHERE version = expectedVersion`); throws on a lost update. */
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  lockById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  findByKeyOrExternalId(idempotencyKey: string, providerId: string, externalTransactionId: string): Promise<WagerTransaction[]>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** A PROCESSED WIN references this transaction and was not rolled back itself. */
  hasActiveWin(referenceTransactionId: string): Promise<boolean>;
  insert(tx: WagerTransaction, at: Date): Promise<void>;
  update(tx: WagerTransaction, at: Date): Promise<void>;
  /** Pulls forward the schedule of transactions waiting on this external id. */
  wakeDependents(providerId: string, externalTransactionId: string, at: Date): Promise<number>;
  findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]>;
  countPendingReferences(): Promise<number>;
}

export interface LedgerTotals {
  credits: Money;
  debits: Money;
  entries: number;
  lastVersion?: number;
  lastBalanceAfter?: Money;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Newest first, keyed by wallet_version (stable and unique per wallet). */
  page(walletId: string, beforeVersion: number | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  totals(walletId: string, currency: string): Promise<LedgerTotals>;
}

export interface InboxRepository {
  /**
   * INSERT … ON CONFLICT DO NOTHING. `duplicate`: the same message was already
   * received; `conflict`: that messageId was received with a different payload.
   */
  tryReceive(message: InboxMessage): Promise<'received' | 'duplicate' | 'conflict'>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
}

/** Repositories bound to one SQL transaction. */
export interface TransactionalStore {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read';
  readOnly?: boolean;
}

export interface UnitOfWork {
  /** Runs `work` in one SQL transaction: everything commits together or nothing does. */
  transaction<T>(work: (store: TransactionalStore) => Promise<T>, options?: TransactionOptions): Promise<T>;
}

export type MessageSource = 'http' | 'sqs' | 'worker';

export interface Metrics {
  transactionOutcome(status: string, kind: string, source: MessageSource): void;
  duplicateDetected(source: MessageSource, type: 'idempotent-replay' | 'inbox' | 'external-id'): void;
  retry(operation: string, reason: string): void;
  lockConflict(kind: 'lock-timeout' | 'deadlock' | 'serialization' | 'version' | 'unique-race'): void;
  dlqMessage(reason: string): void;
  processingLatency(source: MessageSource, seconds: number): void;
  reconciliationDivergence(walletId: string): void;
  idempotencyConflict(source: MessageSource): void;
}

export interface AppLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
