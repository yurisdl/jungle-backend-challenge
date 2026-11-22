import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  ApplicationError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxMessageConflictError,
  InvariantViolationError,
  TransientInfrastructureError,
  UnknownWalletError,
  ValidationError,
} from '../../application/errors';
import type { AppLogger } from '../../application/ports';
import { canonicalJson, sha256Hex } from '../../application/services/payload-hash';
import { parseWagerCommand, type WagerCommand } from '../../application/services/wager-command';
import type { RecordFailedTransaction } from '../../application/use-cases/record-failed-transaction.use-case';
import type { SubmitWagerTransaction } from '../../application/use-cases/submit-wager-transaction.use-case';
import { DomainError, FailureCode } from '../../domain';
import type { AppConfig } from '../config/app-config';
import { errorFields } from '../observability/logger';
import type { PrometheusMetrics } from '../observability/metrics';
import type { FaultInjector } from '../workers/faults';
import { sleep } from '../workers/polling-worker';
import type { QueueRegistry } from './sqs';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

interface Envelope {
  messageId: string;
  type: string;
  occurredAt?: string;
  correlationId?: string;
  data: unknown;
}

type Handling = 'acked' | 'ack-failed' | 'dead-lettered' | 'retry-scheduled' | 'released';

/**
 * SQS consumer for `wager-transactions.fifo`.
 *
 *  - reuses the same use case as HTTP;
 *  - de-duplicates through the persistent inbox (consumerName, messageId);
 *  - deletes (acks) only after the SQL commit;
 *  - business outcomes (PROCESSED / REJECTED / PENDING_REFERENCE / replay) → ack;
 *  - transient errors → visibility backoff, until `maxReceiveCount`;
 *  - permanent errors (invalid payload, idempotency conflict, unknown wallet,
 *    invariant violation, retries exhausted) → explicit DLQ with a reason;
 *  - SIGTERM: stop polling, finish in-flight messages, release the rest.
 */
export class WagerQueueConsumer {
  private running = false;
  private injectedAckFailure = false;
  private loop?: Promise<void>;
  private poll?: AbortController;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueRegistry,
    private readonly submit: SubmitWagerTransaction,
    private readonly recordFailure: RecordFailedTransaction,
    private readonly metrics: PrometheusMetrics,
    private readonly logger: AppLogger,
    private readonly config: AppConfig,
    private readonly faults: FaultInjector,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info({ worker: 'wager-consumer' }, 'consumer started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.poll?.abort();
    await this.loop;
    this.logger.info({ worker: 'wager-consumer' }, 'consumer stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const { wager } = await this.queues.resolve();
        this.poll = new AbortController();
        const out = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: wager,
            MaxNumberOfMessages: Math.min(10, this.config.sqs.concurrency),
            WaitTimeSeconds: this.config.sqs.waitTimeSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: this.poll.signal },
        );
        const messages = out.Messages ?? [];
        if (messages.length === 0) continue;
        // FIFO: keep order inside a message group (= wallet), parallelise across groups.
        const groups = new Map<string, Message[]>();
        for (const m of messages) {
          const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? 'default';
          groups.set(group, [...(groups.get(group) ?? []), m]);
        }
        await Promise.all([...groups.values()].map((group) => this.processGroup(wager, group)));
      } catch (error) {
        if (!this.running) break;
        this.logger.error({ worker: 'wager-consumer', ...errorFields(error) }, 'receive failed');
        await sleep(1_000);
      }
    }
  }

  private async processGroup(queueUrl: string, group: Message[]): Promise<void> {
    for (let i = 0; i < group.length; i++) {
      const message = group[i]!;
      if (!this.running) {
        // shutting down: hand the not-started messages back to SQS immediately
        await Promise.all(group.slice(i).map((m) => this.release(queueUrl, m)));
        return;
      }
      const outcome = await this.handle(queueUrl, message);
      this.metrics.sqsMessages.inc({ outcome });
      if (outcome === 'retry-scheduled') {
        // FIFO ordering: later messages of the same group must wait as well
        await Promise.all(group.slice(i + 1).map((m) => this.release(queueUrl, m)));
        return;
      }
    }
  }

  /** Exposed for tests. */
  async handle(queueUrl: string, message: Message): Promise<Handling> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let envelope: Envelope;
    let command: WagerCommand;
    try {
      envelope = parseEnvelope(message.Body);
      const data = envelope.data as Record<string, unknown>;
      command = parseWagerCommand(data, data?.idempotencyKey);
    } catch (error) {
      this.logger.warn({ sqsMessageId: message.MessageId, ...errorFields(error) }, 'invalid queue message');
      return this.deadLetter(queueUrl, message, error instanceof ApplicationError ? error.code : 'INVALID_MESSAGE');
    }

    const log = {
      correlationId: envelope.correlationId ?? envelope.messageId,
      messageId: envelope.messageId,
      walletId: command.walletId,
      providerId: command.providerId,
    };
    try {
      await this.submit.execute(command, {
        source: 'sqs',
        correlationId: log.correlationId,
        inbox: {
          consumerName: this.config.sqs.consumerName,
          messageId: envelope.messageId,
          payloadHash: sha256Hex(canonicalJson(envelope.data)),
        },
      });
    } catch (error) {
      if (isPermanent(error)) {
        this.logger.warn({ ...log, ...errorFields(error) }, 'permanent failure, dead-lettering');
        if (error instanceof InvariantViolationError) {
          await this.recordFailure.execute(command, FailureCode.InternalInvariantViolation, log.correlationId);
        }
        return this.deadLetter(queueUrl, message, (error as { code?: string }).code ?? 'PERMANENT_ERROR');
      }
      if (receiveCount >= this.config.sqs.maxReceiveCount) {
        this.logger.error({ ...log, receiveCount, ...errorFields(error) }, 'retries exhausted, dead-lettering');
        await this.recordFailure.execute(command, FailureCode.ProcessingRetriesExhausted, log.correlationId);
        return this.deadLetter(queueUrl, message, 'RETRIES_EXHAUSTED');
      }
      const delay = Math.min(this.config.sqs.transientBackoffBaseSeconds * 2 ** (receiveCount - 1), 300);
      this.logger.warn({ ...log, receiveCount, retryInSeconds: delay, ...errorFields(error) }, 'transient failure, will retry');
      this.metrics.retry('sqs-consume', error instanceof TransientInfrastructureError ? error.reason : 'unexpected');
      await this.changeVisibility(queueUrl, message, delay).catch((visibilityError: unknown) =>
        // the message comes back when its current visibility timeout ends instead
        this.logger.warn({ ...log, ...errorFields(visibilityError) }, 'could not reschedule message'),
      );
      return 'retry-scheduled';
    }

    // Committed. Whatever happens from here on (a crash, a failed delete), SQS
    // redelivers the message and the inbox recognises it: never a DLQ case.
    this.faults.crashIfActive('crash-after-commit');
    try {
      if (this.faults.isActive('fail-ack-once') && !this.injectedAckFailure) {
        this.injectedAckFailure = true;
        throw new Error('fault injected: fail-ack-once');
      }
      await this.ack(queueUrl, message);
      return 'acked';
    } catch (error) {
      this.logger.warn({ ...log, ...errorFields(error) }, 'ack failed after commit, the redelivery will be absorbed by the inbox');
      return 'ack-failed';
    }
  }

  private async deadLetter(queueUrl: string, message: Message, reason: string): Promise<Handling> {
    const { wagerDlq } = await this.queues.resolve();
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: wagerDlq,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          deadLetterReason: { DataType: 'String', StringValue: reason },
          originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
        },
      }),
    );
    await this.ack(queueUrl, message);
    this.metrics.dlqMessage(reason);
    return 'dead-lettered';
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async release(queueUrl: string, message: Message): Promise<void> {
    await this.changeVisibility(queueUrl, message, 0).catch(() => undefined);
    this.metrics.sqsMessages.inc({ outcome: 'released' });
  }

  private async changeVisibility(queueUrl: string, message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}

function parseEnvelope(body: string | undefined): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    throw new ValidationError('INVALID_MESSAGE', 'message body is not JSON');
  }
  const e = parsed as Partial<Envelope>;
  if (!e || typeof e !== 'object' || typeof e.messageId !== 'string' || e.messageId.length === 0) {
    throw new ValidationError('INVALID_MESSAGE', 'messageId is required');
  }
  if (e.type !== WAGER_MESSAGE_TYPE) {
    throw new ValidationError('INVALID_MESSAGE', `unsupported message type ${String(e.type)}`);
  }
  if (!e.data || typeof e.data !== 'object') {
    throw new ValidationError('INVALID_MESSAGE', 'data is required');
  }
  return e as Envelope;
}

function isPermanent(error: unknown): boolean {
  return (
    error instanceof ValidationError ||
    error instanceof IdempotencyConflictError ||
    error instanceof InboxMessageConflictError ||
    error instanceof ExternalTransactionConflictError ||
    error instanceof UnknownWalletError ||
    error instanceof InvariantViolationError ||
    error instanceof DomainError
  );
}
