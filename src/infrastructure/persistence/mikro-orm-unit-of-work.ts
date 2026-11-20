import { IsolationLevel, LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerRepository,
  LedgerTotals,
  OutboxRepository,
  TransactionalStore,
  TransactionOptions,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import {
  type InboxMessage,
  Money,
  type OutboxMessage,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type Wallet,
  type WalletLedgerEntry,
} from '../../domain';
import { translateDbError } from './db-errors';
import { LedgerEntryMapper, OutboxMapper, WagerTransactionMapper, WalletMapper } from './mappers';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './schemas/records';

/** Every read goes to the database: the identity map is never trusted inside a transaction. */
const FRESH = { disableIdentityMap: true } as const;

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, FRESH);
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { playerId, currency }, FRESH);
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
  }

  async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError('version', `wallet ${wallet.id} changed concurrently (expected v${expectedVersion})`);
    }
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { id }, FRESH);
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { id }, { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE });
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { idempotencyKey }, FRESH);
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }, FRESH);
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insert(tx: WagerTransaction, at: Date): Promise<void> {
    await this.em.insert(WagerTransactionRecord, WagerTransactionMapper.toRecord(tx, at));
  }

  async update(tx: WagerTransaction, at: Date): Promise<void> {
    const r = WagerTransactionMapper.toRecord(tx, at);
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id },
      {
        status: r.status,
        failureCode: r.failureCode,
        referenceTransactionId: r.referenceTransactionId,
        observedBalanceAmount: r.observedBalanceAmount,
        attempts: r.attempts,
        nextAttemptAt: r.nextAttemptAt,
        processedAt: r.processedAt,
        updatedAt: at,
      },
    );
    if (affected !== 1) throw new ConcurrencyConflictError('version', `transaction ${tx.id} vanished`);
  }

  async wakeDependents(providerId: string, externalTransactionId: string, at: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        status: WagerTransactionStatus.PendingReference,
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        nextAttemptAt: { $gt: at },
      },
      { nextAttemptAt: at, updatedAt: at },
    );
  }

  async findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]> {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
      { ...FRESH, fields: ['id'], orderBy: { nextAttemptAt: 'asc' }, limit },
    );
    return rows.map((r) => r.id);
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }

  async page(walletId: string, beforeVersion: number | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    const where = beforeVersion ? { walletId, walletVersion: { $lt: beforeVersion } } : { walletId };
    const rows = await this.em.find(LedgerEntryRecord, where, { ...FRESH, orderBy: { walletVersion: 'desc' }, limit });
    return rows.map(LedgerEntryMapper.toDomain);
  }

  async totals(walletId: string, currency: string): Promise<LedgerTotals> {
    const rows = await this.em.execute<
      Array<{ credits: string; debits: string; entries: number; last_version: number | null; last_after: string | null }>
    >(
      `select coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::text as credits,
              coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::text  as debits,
              count(*)::int as entries,
              max(wallet_version) as last_version,
              (select balance_after::text from wallet_ledger_entries
                where wallet_id = ? order by wallet_version desc limit 1) as last_after
         from wallet_ledger_entries where wallet_id = ?`,
      [walletId, walletId],
    );
    const row = rows[0]!;
    const toMoney = (v: string) => Money.from({ amount: normaliseNumeric(v), currency });
    return {
      credits: toMoney(row.credits),
      debits: toMoney(row.debits),
      entries: row.entries,
      lastVersion: row.last_version ?? undefined,
      lastBalanceAfter: row.last_after != null ? toMoney(row.last_after) : undefined,
    };
  }
}

/** `sum()` over numeric(18,2) keeps scale 2, but `0` comes back without decimals. */
function normaliseNumeric(value: string): string {
  return value.includes('.') ? value : `${value}.00`;
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<Array<{ message_id: string }>>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    return rows.length === 1;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? new Date() },
    );
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageRecord, messages.map(OutboxMapper.toRecord));
  }
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly timeouts: { lockTimeoutMs: number; statementTimeoutMs: number },
  ) {}

  async transaction<T>(work: (store: TransactionalStore) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const em = this.orm.em.fork({ clear: true, useContext: false });
    try {
      return await em.transactional(
        async (tem) => {
          await tem.execute(
            `select set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)`,
            [`${this.timeouts.lockTimeoutMs}ms`, `${this.timeouts.statementTimeoutMs}ms`],
          );
          return work({
            wallets: new MikroOrmWalletRepository(tem),
            transactions: new MikroOrmWagerTransactionRepository(tem),
            ledger: new MikroOrmLedgerRepository(tem),
            inbox: new MikroOrmInboxRepository(tem),
            outbox: new MikroOrmOutboxRepository(tem),
          });
        },
        {
          isolationLevel:
            options.isolation === 'repeatable read' ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED,
          readOnly: options.readOnly ?? false,
        },
      );
    } catch (error) {
      throw translateDbError(error);
    }
  }
}
