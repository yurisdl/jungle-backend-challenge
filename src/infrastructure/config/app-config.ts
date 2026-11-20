import { hostname } from 'node:os';

export type AppRole = 'api' | 'consumer' | 'outbox' | 'pending-reference';

export interface AppConfig {
  instanceId: string;
  port: number;
  roles: AppRole[];
  logLevel: string;
  database: {
    url: string;
    poolMin: number;
    poolMax: number;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
    connectTimeoutMs: number;
    acquireTimeoutMs: number;
  };
  sqs: {
    endpoint?: string;
    region: string;
    requestTimeoutMs: number;
    accessKeyId: string;
    secretAccessKey: string;
    autoCreateQueues: boolean;
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    consumerName: string;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    maxReceiveCount: number;
    concurrency: number;
    transientBackoffBaseSeconds: number;
  };
  outbox: {
    pollIntervalMs: number;
    batchSize: number;
    retryBaseMs: number;
    retryMaxMs: number;
  };
  pendingReference: {
    pollIntervalMs: number;
    batchSize: number;
    baseDelayMs: number;
    maxDelayMs: number;
    maxAttempts: number;
  };
  /** Test-only fault injection points (e.g. "crash-after-commit"). Empty in production. */
  faults: string[];
}

const int = (value: string | undefined, fallback: number) => {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`invalid integer env value "${value}"`);
  return parsed;
};

const list = (value: string | undefined, fallback: string[]) =>
  value === undefined ? fallback : value.split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    instanceId: env.INSTANCE_ID ?? `${hostname()}-${process.pid}`,
    port: int(env.PORT, 3000),
    roles: list(env.APP_ROLES, ['api', 'consumer', 'outbox', 'pending-reference']) as AppRole[],
    logLevel: env.LOG_LEVEL ?? 'info',
    database: {
      url: env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
      poolMin: int(env.DB_POOL_MIN, 1),
      poolMax: int(env.DB_POOL_MAX, 20),
      lockTimeoutMs: int(env.DB_LOCK_TIMEOUT_MS, 5_000),
      statementTimeoutMs: int(env.DB_STATEMENT_TIMEOUT_MS, 15_000),
      connectTimeoutMs: int(env.DB_CONNECT_TIMEOUT_MS, 3_000),
      acquireTimeoutMs: int(env.DB_ACQUIRE_TIMEOUT_MS, 5_000),
    },
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566',
      region: env.AWS_REGION ?? 'us-east-1',
      requestTimeoutMs: int(env.SQS_REQUEST_TIMEOUT_MS, 5_000),
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
      autoCreateQueues: (env.SQS_AUTO_CREATE_QUEUES ?? 'true') === 'true',
      wagerQueueName: env.SQS_WAGER_QUEUE ?? 'wager-transactions.fifo',
      wagerDlqName: env.SQS_WAGER_DLQ ?? 'wager-transactions-dlq.fifo',
      eventsQueueName: env.SQS_EVENTS_QUEUE ?? 'wagering-events.fifo',
      consumerName: env.SQS_CONSUMER_NAME ?? 'wager-transactions-consumer',
      waitTimeSeconds: int(env.SQS_WAIT_TIME_SECONDS, 5),
      visibilityTimeoutSeconds: int(env.SQS_VISIBILITY_TIMEOUT_SECONDS, 30),
      maxReceiveCount: int(env.SQS_MAX_RECEIVE_COUNT, 5),
      concurrency: int(env.SQS_CONCURRENCY, 10),
      transientBackoffBaseSeconds: int(env.SQS_TRANSIENT_BACKOFF_BASE_SECONDS, 2),
    },
    outbox: {
      pollIntervalMs: int(env.OUTBOX_POLL_INTERVAL_MS, 500),
      batchSize: int(env.OUTBOX_BATCH_SIZE, 50),
      retryBaseMs: int(env.OUTBOX_RETRY_BASE_MS, 1_000),
      retryMaxMs: int(env.OUTBOX_RETRY_MAX_MS, 60_000),
    },
    pendingReference: {
      pollIntervalMs: int(env.PENDING_REFERENCE_POLL_INTERVAL_MS, 1_000),
      batchSize: int(env.PENDING_REFERENCE_BATCH_SIZE, 50),
      baseDelayMs: int(env.PENDING_REFERENCE_BASE_DELAY_MS, 2_000),
      maxDelayMs: int(env.PENDING_REFERENCE_MAX_DELAY_MS, 300_000),
      maxAttempts: int(env.PENDING_REFERENCE_MAX_ATTEMPTS, 10),
    },
    faults: list(env.FAULT_INJECTION, []),
  };
}
