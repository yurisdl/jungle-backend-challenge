import { InboxMessage, Money, settleWager, WagerTransaction } from '../../domain';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  TransientInfrastructureError,
  UnknownWalletError,
} from '../errors';
import type { AppLogger, Clock, IdGenerator, MessageSource, Metrics, TransactionalStore, UnitOfWork } from '../ports';
import { withConflictRetry } from '../services/conflict-retry';
import { KeyedSerializer } from '../services/keyed-serializer';
import { hashOf, type WagerCommand } from '../services/wager-command';
import {
  nextReferenceAttempt,
  type ReferenceRetryPolicy,
  toResultView,
  type WagerResultView,
  WagerSettlementWriter,
} from './wager-settlement.service';

export interface SubmitContext {
  source: MessageSource;
  correlationId: string;
  /** Present when the request came from the queue: dedup by (consumerName, messageId). */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

export type SubmitResult =
  | { type: 'result'; view: WagerResultView }
  | { type: 'duplicate-message' };

/**
 * Single entry point for wager transactions — used by HTTP and SQS alike.
 *
 * Algorithm (one SQL transaction, READ COMMITTED):
 *  1. inbox insert (SQS only) — duplicate message ⇒ stop;
 *  2. idempotency lookup — replay or conflict without taking any lock;
 *  3. `SELECT … FOR UPDATE` on the wallet row (unit of concurrency);
 *  4. idempotency lookup again (another instance may have committed while we waited);
 *  5. domain settlement, then transaction + wallet (version-guarded) + ledger + outbox writes;
 *  6. commit. Unique-index races / deadlocks re-run the whole transaction.
 */
export class SubmitWagerTransaction {
  private readonly writer: WagerSettlementWriter;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly referencePolicy: ReferenceRetryPolicy,
    private readonly walletGate: KeyedSerializer = new KeyedSerializer(),
  ) {
    this.writer = new WagerSettlementWriter(ids);
  }

  async execute(command: WagerCommand, ctx: SubmitContext): Promise<SubmitResult> {
    const started = performance.now();
    const payloadHash = hashOf(command);
    let result: SubmitResult;
    try {
      result = await this.walletGate.run(command.walletId, () =>
        withConflictRetry(this.metrics, { operation: 'submit-wager' }, () =>
          this.uow.transaction((store) => this.attempt(store, command, payloadHash, ctx)),
        ),
      );
    } catch (error) {
      if (error instanceof TransientInfrastructureError && error.reason === 'LOCK_TIMEOUT') {
        this.metrics.lockConflict('lock-timeout');
      }
      throw error;
    }
    this.metrics.processingLatency(ctx.source, (performance.now() - started) / 1000);
    if (result.type === 'result') {
      if (result.view.idempotentReplay) {
        this.metrics.duplicateDetected(ctx.source, 'idempotent-replay');
      } else {
        this.metrics.transactionOutcome(result.view.status, command.kind, ctx.source);
      }
      this.logger.info(
        {
          correlationId: ctx.correlationId,
          messageId: ctx.inbox?.messageId,
          transactionId: result.view.transactionId,
          walletId: command.walletId,
          providerId: command.providerId,
          kind: command.kind,
          status: result.view.status,
          failureCode: result.view.failureCode,
          idempotentReplay: result.view.idempotentReplay,
        },
        'wager transaction handled',
      );
    } else {
      this.metrics.duplicateDetected(ctx.source, 'inbox');
      this.logger.info(
        { correlationId: ctx.correlationId, messageId: ctx.inbox?.messageId, walletId: command.walletId },
        'duplicate queue message ignored',
      );
    }
    return result;
  }

  private async attempt(
    store: TransactionalStore,
    command: WagerCommand,
    payloadHash: string,
    ctx: SubmitContext,
  ): Promise<SubmitResult> {
    const now = this.clock.now();
    let inbox: InboxMessage | undefined;
    if (ctx.inbox) {
      inbox = InboxMessage.receive({ ...ctx.inbox, receivedAt: now });
      const fresh = await store.inbox.tryReceive(inbox);
      if (!fresh) return { type: 'duplicate-message' };
    }
    const finish = async (result: SubmitResult): Promise<SubmitResult> => {
      if (inbox) {
        inbox.markProcessed(this.clock.now());
        await store.inbox.markProcessed(inbox);
      }
      return result;
    };

    const early = await this.replay(store, command, payloadHash, ctx);
    if (early) return finish(early);

    const wallet = await store.wallets.lockById(command.walletId);
    if (!wallet) {
      throw new UnknownWalletError(`wallet ${command.walletId} does not exist`);
    }
    // one round trip under the lock: same key (replay/conflict) or same external id (conflict)
    const clashes = await store.transactions.findByKeyOrExternalId(
      command.idempotencyKey,
      command.providerId,
      command.externalTransactionId,
    );
    const sameKey = clashes.find((t) => t.idempotencyKey === command.idempotencyKey);
    if (sameKey) return finish(this.replayOf(sameKey, command, payloadHash, ctx));
    const sameExternal = clashes[0];
    if (sameExternal) {
      this.metrics.duplicateDetected(ctx.source, 'external-id');
      throw new ExternalTransactionConflictError(
        `${command.providerId}/${command.externalTransactionId} was already submitted with another Idempotency-Key`,
        { transactionId: sameExternal.id },
      );
    }

    const at = this.clock.now();
    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: at,
    });
    const previousVersion = wallet.version;
    const reference = await this.writer.lookupReference(store, tx);
    const outcome = settleWager(tx, wallet, reference, {
      at,
      ledgerEntryId: this.ids.next(),
      nextAttemptAt: nextReferenceAttempt(this.referencePolicy, at, 0),
      referenceRetriesExhausted: false,
    });
    await store.transactions.insert(tx, at);
    await this.writer.persistOutcome(
      store,
      tx,
      wallet,
      previousVersion,
      outcome,
      { correlationId: ctx.correlationId, causationId: ctx.inbox?.messageId ?? command.idempotencyKey },
      at,
    );
    return finish({ type: 'result', view: toResultView(tx, false) });
  }

  private async replay(
    store: TransactionalStore,
    command: WagerCommand,
    payloadHash: string,
    ctx: SubmitContext,
  ): Promise<SubmitResult | undefined> {
    const existing = await store.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (!existing) return undefined;
    return this.replayOf(existing, command, payloadHash, ctx);
  }

  private replayOf(
    existing: WagerTransaction,
    command: WagerCommand,
    payloadHash: string,
    ctx: SubmitContext,
  ): SubmitResult {
    if (!existing.matchesPayload(payloadHash)) {
      this.metrics.idempotencyConflict(ctx.source);
      throw new IdempotencyConflictError(
        `Idempotency-Key ${command.idempotencyKey} was already used with a different payload`,
        { transactionId: existing.id },
      );
    }
    return { type: 'result', view: toResultView(existing, true) };
  }
}

