import { type FailureCode, Money, WagerTransaction } from '../../domain';
import type { AppLogger, Clock, IdGenerator, UnitOfWork } from '../ports';
import { hashOf, type WagerCommand } from '../services/wager-command';

/**
 * Records a permanent infrastructure failure (status FAILED) so the
 * outcome stays auditable after a message is dead-lettered. Best effort:
 * if the database is the thing that is down, the DLQ is the audit trail.
 * No balance, ledger or event is touched.
 */
export class RecordFailedTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: AppLogger,
  ) {}

  async execute(command: WagerCommand, code: FailureCode, correlationId: string): Promise<string | undefined> {
    try {
      return await this.uow.transaction(async (store) => {
        if (await store.transactions.findByIdempotencyKey(command.idempotencyKey)) return undefined;
        if (await store.transactions.findByExternalId(command.providerId, command.externalTransactionId)) return undefined;
        if (!(await store.wallets.findById(command.walletId))) return undefined;
        const at = this.clock.now();
        const tx = WagerTransaction.create({
          id: this.ids.next(),
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: command.idempotencyKey,
          payloadHash: hashOf(command),
          walletId: command.walletId,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money: Money.from(command.money),
          referenceExternalTransactionId: command.referenceExternalTransactionId,
          createdAt: at,
        });
        tx.fail(code, at);
        await store.transactions.insert(tx, at);
        this.logger.warn(
          { correlationId, transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId, failureCode: code },
          'transaction recorded as FAILED',
        );
        return tx.id;
      });
    } catch (error) {
      const cause = error instanceof Error ? { type: error.name, message: error.message } : { message: String(error) };
      this.logger.error({ correlationId, walletId: command.walletId, error: cause }, 'could not record FAILED transaction');
      return undefined;
    }
  }
}
