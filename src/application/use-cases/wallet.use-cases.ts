import {
  InvalidMoneyError,
  LedgerDirection,
  Money,
  type MoneyProps,
  OutboxMessage,
  WagerTransaction,
  type WagerTransactionKind,
  Wallet,
  WalletBalanceChanged,
  type WalletLedgerEntry,
} from '../../domain';
import {
  ConcurrencyConflictError,
  ResourceNotFoundError,
  ValidationError,
  WalletAlreadyExistsError,
} from '../errors';
import type { AppLogger, Clock, IdGenerator, Metrics, UnitOfWork } from '../ports';
import { canonicalJson, sha256Hex } from '../services/payload-hash';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function parseUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ValidationError('INVALID_PAYLOAD', `${field} must be a UUID`, { issues: { [field]: 'must be a UUID' } });
  }
  return value.toLowerCase();
}

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: AppLogger,
  ) {}

  async execute(raw: unknown, correlationId: string): Promise<WalletView> {
    if (raw === null || typeof raw !== 'object') {
      throw new ValidationError('INVALID_PAYLOAD', 'body must be a JSON object');
    }
    const body = raw as Record<string, unknown>;
    const playerId = parseUuid(body.playerId, 'playerId');
    let initialBalance: Money;
    try {
      initialBalance = Money.from(body.initialBalance as MoneyProps);
    } catch (err) {
      throw new ValidationError('INVALID_PAYLOAD', err instanceof InvalidMoneyError ? err.message : 'invalid money', {
        issues: { initialBalance: 'invalid money' },
      });
    }

    try {
      const view = await this.uow.transaction(async (store) => {
        const existing = await store.wallets.findByPlayerAndCurrency(playerId, initialBalance.currency);
        if (existing) throw this.duplicate(playerId, initialBalance.currency);

        const at = this.clock.now();
        const walletId = this.ids.next();
        const openingTxId = this.ids.next();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId,
          initialBalance,
          at,
          opening: { transactionId: openingTxId, ledgerEntryId: this.ids.next() },
        });
        await store.wallets.insert(wallet);
        if (openingEntry) {
          const opening = WagerTransaction.opening({
            id: openingTxId,
            providerId: 'internal',
            externalTransactionId: `opening:${walletId}`,
            idempotencyKey: `internal:opening:${walletId}`,
            payloadHash: sha256Hex(canonicalJson({ walletId, playerId, initialBalance: initialBalance.toJSON() })),
            walletId,
            playerId,
            roundId: 'opening',
            gameId: 'internal',
            money: initialBalance,
            createdAt: at,
          });
          opening.markProcessed(undefined, at, wallet.balance);
          await store.transactions.insert(opening, at);
          await store.ledger.insert(openingEntry);
          await store.outbox.enqueue([
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, {
                eventId: this.ids.next(),
                correlationId,
                causationId: openingTxId,
                occurredAt: at,
              }),
            ),
          ]);
        }
        return wallet.toJSON();
      });
      this.logger.info({ correlationId, walletId: view.id }, 'wallet created');
      return view;
    } catch (error) {
      if (error instanceof ConcurrencyConflictError && error.constraint === 'wallets_player_currency_uq') {
        throw this.duplicate(playerId, initialBalance.currency);
      }
      throw error;
    }
  }

  private duplicate(playerId: string, currency: string) {
    return new WalletAlreadyExistsError(`player ${playerId} already has a ${currency} wallet`);
  }
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  walletId: string;
  items: LedgerEntryView[];
  nextCursor: string | null;
}

/** Opaque, stable cursor: base64url of the last wallet_version seen. */
export const LedgerCursor = {
  encode(version: number): string {
    return Buffer.from(JSON.stringify({ v: version }), 'utf8').toString('base64url');
  },
  decode(cursor: string): number {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
      if (typeof parsed.v === 'number' && Number.isInteger(parsed.v) && parsed.v > 0) return parsed.v;
    } catch {
      /* fallthrough */
    }
    throw new ValidationError('INVALID_CURSOR', 'cursor is invalid');
  },
};

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  walletVersion: number;
  lastLedgerVersion: number | null;
}

export class WalletQueries {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const id = parseUuid(walletId, 'walletId');
    const wallet = await this.uow.transaction((s) => s.wallets.findById(id), { readOnly: true });
    if (!wallet) throw new ResourceNotFoundError(`wallet ${id} not found`);
    return wallet.toJSON();
  }

  async ledger(walletId: string, cursor: string | undefined, limitRaw: string | undefined): Promise<LedgerPageView> {
    const id = parseUuid(walletId, 'walletId');
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError('INVALID_PAYLOAD', 'limit must be an integer between 1 and 200');
    }
    const before = cursor ? LedgerCursor.decode(cursor) : undefined;
    return this.uow.transaction(
      async (s) => {
        const wallet = await s.wallets.findById(id);
        if (!wallet) throw new ResourceNotFoundError(`wallet ${id} not found`);
        const entries = await s.ledger.page(id, before, limit + 1);
        const page = entries.slice(0, limit);
        const last = page[page.length - 1];
        return {
          walletId: id,
          items: page.map(viewOfEntry),
          nextCursor: entries.length > limit && last ? LedgerCursor.encode(last.walletVersion) : null,
        };
      },
      { readOnly: true },
    );
  }

  /**
   * Recomputes the balance from the ledger in one REPEATABLE READ snapshot.
   * Divergences are never fixed silently: logged, counted and reported.
   */
  async reconcile(walletId: string, correlationId: string): Promise<ReconciliationView> {
    const id = parseUuid(walletId, 'walletId');
    const view = await this.uow.transaction(
      async (s) => {
        const wallet = await s.wallets.findById(id);
        if (!wallet) throw new ResourceNotFoundError(`wallet ${id} not found`);
        const totals = await s.ledger.totals(id, wallet.currency);
        const calculated = totals.credits.subtract(totals.debits);
        const difference = wallet.balance.subtract(calculated);
        const chainOk =
          totals.entries === 0
            ? wallet.balance.isZero() && wallet.version === 1
            : totals.lastBalanceAfter!.equals(wallet.balance) && totals.lastVersion === wallet.version;
        return {
          walletId: id,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: calculated.toJSON(),
          difference: difference.toJSON(),
          consistent: difference.isZero() && chainOk,
          checkedEntries: totals.entries,
          walletVersion: wallet.version,
          lastLedgerVersion: totals.lastVersion ?? null,
        } satisfies ReconciliationView;
      },
      { isolation: 'repeatable read', readOnly: true },
    );
    if (!view.consistent) {
      this.metrics.reconciliationDivergence(id);
      this.logger.error(
        {
          correlationId,
          walletId: id,
          difference: view.difference.amount,
          walletVersion: view.walletVersion,
          lastLedgerVersion: view.lastLedgerVersion,
        },
        'wallet reconciliation divergence',
      );
    } else {
      this.logger.info({ correlationId, walletId: id, checkedEntries: view.checkedEntries }, 'wallet reconciled');
    }
    return view;
  }
}

export function viewOfEntry(e: WalletLedgerEntry): LedgerEntryView {
  return {
    id: e.id,
    transactionId: e.transactionId,
    direction: e.direction,
    money: e.money.toJSON(),
    balanceBefore: e.balanceBefore.toJSON(),
    balanceAfter: e.balanceAfter.toJSON(),
    walletVersion: e.walletVersion,
    createdAt: e.createdAt.toISOString(),
  };
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  balance: MoneyProps | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

export function viewOfTransaction(t: WagerTransaction): TransactionView {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    referenceTransactionId: t.referenceTransactionId ?? null,
    status: t.status,
    failureCode: t.failureCode ?? null,
    balance: t.observedBalance && t.observedBalance.currency === t.money.currency ? t.observedBalance.toJSON() : null,
    attempts: t.attempts,
    nextAttemptAt: t.nextAttemptAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString() ?? null,
  };
}

export class TransactionQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<TransactionView> {
    const id = parseUuid(transactionId, 'transactionId');
    const tx = await this.uow.transaction((s) => s.transactions.findById(id), { readOnly: true });
    if (!tx) throw new ResourceNotFoundError(`transaction ${id} not found`);
    return viewOfTransaction(tx);
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.uow.transaction((s) => s.transactions.findByExternalId(providerId, externalTransactionId), {
      readOnly: true,
    });
    if (!tx) throw new ResourceNotFoundError(`transaction ${providerId}/${externalTransactionId} not found`);
    return viewOfTransaction(tx);
  }
}

export { LedgerDirection };
