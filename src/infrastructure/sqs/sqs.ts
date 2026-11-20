import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config/app-config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.sqs.region,
    endpoint: config.sqs.endpoint,
    credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
    maxAttempts: 2,
    requestHandler: { requestTimeout: 25_000, connectionTimeout: 3_000 },
  });
}

export interface QueueUrls {
  wager: string;
  wagerDlq: string;
  events: string;
}

/** Resolves (and, for local environments, creates) the queues. Idempotent. */
export class QueueRegistry {
  private urls?: QueueUrls;

  constructor(
    private readonly sqs: SQSClient,
    private readonly config: AppConfig,
  ) {}

  async resolve(): Promise<QueueUrls> {
    if (this.urls) return this.urls;
    const { sqs: c } = this.config;
    if (c.autoCreateQueues) {
      const dlqUrl = await this.create(c.wagerDlqName, { MessageRetentionPeriod: '1209600' });
      const attrs = await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
      );
      const dlqArn = attrs.Attributes?.QueueArn;
      const wagerUrl = await this.create(c.wagerQueueName, {
        VisibilityTimeout: String(c.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(c.maxReceiveCount) }),
      });
      const eventsUrl = await this.create(c.eventsQueueName, {});
      this.urls = { wager: wagerUrl, wagerDlq: dlqUrl, events: eventsUrl };
    } else {
      this.urls = {
        wager: await this.urlOf(c.wagerQueueName),
        wagerDlq: await this.urlOf(c.wagerDlqName),
        events: await this.urlOf(c.eventsQueueName),
      };
    }
    return this.urls;
  }

  async ping(): Promise<void> {
    const urls = await this.resolve();
    await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: urls.wager, AttributeNames: ['QueueArn'] }));
  }

  private async create(name: string, attributes: Record<string, string>): Promise<string> {
    const fifo = name.endsWith('.fifo');
    const out = await this.sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          ...(fifo ? { FifoQueue: 'true', ContentBasedDeduplication: 'false' } : {}),
          ...attributes,
        },
      }),
    );
    return out.QueueUrl!;
  }

  private async urlOf(name: string): Promise<string> {
    const out = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    return out.QueueUrl!;
  }
}
