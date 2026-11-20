import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from './application/ports';
import { KeyedSerializer } from './application/services/keyed-serializer';
import { RecordFailedTransaction } from './application/use-cases/record-failed-transaction.use-case';
import { RetryPendingReference } from './application/use-cases/retry-pending-reference.use-case';
import { SubmitWagerTransaction } from './application/use-cases/submit-wager-transaction.use-case';
import { CreateWallet, TransactionQueries, WalletQueries } from './application/use-cases/wallet.use-cases';
import type { AppConfig } from './infrastructure/config/app-config';
import { PinoAppLogger } from './infrastructure/observability/logger';
import { PrometheusMetrics } from './infrastructure/observability/metrics';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrm } from './infrastructure/persistence/orm';
import { createSqsClient, QueueRegistry } from './infrastructure/sqs/sqs';
import { WagerQueueConsumer } from './infrastructure/sqs/wager-consumer';
import { SystemClock, UuidV7Generator } from './infrastructure/system';
import { FaultInjector } from './infrastructure/workers/faults';
import { OutboxPublisher } from './infrastructure/workers/outbox-publisher';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference-worker';

/**
 * Composition root: wires ports to adapters by hand. NestJS only hosts the
 * HTTP layer; the domain and application layers never see the framework.
 */
export class AppContainer {
  readonly logger: PinoAppLogger;
  readonly metrics = new PrometheusMetrics();
  readonly clock = new SystemClock();
  readonly ids = new UuidV7Generator();
  readonly walletGate = new KeyedSerializer();
  readonly faults: FaultInjector;
  readonly sqs: SQSClient;
  readonly queues: QueueRegistry;
  readonly uow: UnitOfWork;

  readonly submitWager: SubmitWagerTransaction;
  readonly retryPendingReference: RetryPendingReference;
  readonly recordFailedTransaction: RecordFailedTransaction;
  readonly createWallet: CreateWallet;
  readonly walletQueries: WalletQueries;
  readonly transactionQueries: TransactionQueries;

  readonly consumer: WagerQueueConsumer;
  readonly outboxPublisher: OutboxPublisher;
  readonly pendingReferenceWorker: PendingReferenceWorker;

  private constructor(
    readonly config: AppConfig,
    readonly orm: MikroORM,
  ) {
    this.logger = new PinoAppLogger(config.logLevel, { instanceId: config.instanceId });
    this.faults = new FaultInjector(config.faults);
    this.sqs = createSqsClient(config);
    this.queues = new QueueRegistry(this.sqs, config);
    this.uow = new MikroOrmUnitOfWork(orm);

    const referencePolicy = config.pendingReference;
    this.submitWager = new SubmitWagerTransaction(
      this.uow,
      this.clock,
      this.ids,
      this.metrics,
      this.logger,
      referencePolicy,
      this.walletGate,
    );
    this.retryPendingReference = new RetryPendingReference(
      this.uow,
      this.clock,
      this.ids,
      this.metrics,
      this.logger,
      referencePolicy,
    );
    this.recordFailedTransaction = new RecordFailedTransaction(this.uow, this.clock, this.ids, this.logger);
    this.createWallet = new CreateWallet(this.uow, this.clock, this.ids, this.logger);
    this.walletQueries = new WalletQueries(this.uow, this.metrics, this.logger);
    this.transactionQueries = new TransactionQueries(this.uow);

    this.consumer = new WagerQueueConsumer(
      this.sqs,
      this.queues,
      this.submitWager,
      this.recordFailedTransaction,
      this.metrics,
      this.logger,
      config,
      this.faults,
    );
    this.outboxPublisher = new OutboxPublisher(
      orm,
      this.sqs,
      this.queues,
      this.clock,
      this.metrics,
      this.logger,
      config,
      this.faults,
    );
    this.pendingReferenceWorker = new PendingReferenceWorker(
      this.retryPendingReference,
      this.metrics,
      this.logger,
      config,
    );
  }

  static async create(config: AppConfig): Promise<AppContainer> {
    const orm = await createOrm(config);
    return new AppContainer(config, orm);
  }

  startWorkers(): void {
    if (this.config.roles.includes('consumer')) this.consumer.start();
    if (this.config.roles.includes('outbox')) this.outboxPublisher.start();
    if (this.config.roles.includes('pending-reference')) this.pendingReferenceWorker.start();
  }

  async stopWorkers(): Promise<void> {
    await Promise.all([this.consumer.stop(), this.outboxPublisher.stop(), this.pendingReferenceWorker.stop()]);
  }

  async close(): Promise<void> {
    await this.stopWorkers();
    this.sqs.destroy();
    await this.orm.close(true);
  }
}
