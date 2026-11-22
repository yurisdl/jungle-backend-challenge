import {
  DeleteMessageBatchCommand,
  type Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type AddressInfo, createServer } from 'node:net';
import { resolve } from 'node:path';
import { startApplication, type RunningApp } from '../../src/app';
import { type AppConfig, loadConfig } from '../../src/infrastructure/config/app-config';
import { ormOptions } from '../../src/infrastructure/persistence/orm';
import { createSqsClient, QueueRegistry, type QueueUrls } from '../../src/infrastructure/sqs/sqs';

export const ROOT = resolve(__dirname, '../..');

/** Infrastructure comes from docker compose (`bun run infra:up`). */
export const BASE_ENV: Record<string, string> = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
  SQS_ENDPOINT: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
  SQS_WAIT_TIME_SECONDS: '1',
  SQS_VISIBILITY_TIMEOUT_SECONDS: '3',
  SQS_MAX_RECEIVE_COUNT: '3',
  SQS_TRANSIENT_BACKOFF_BASE_SECONDS: '1',
  OUTBOX_POLL_INTERVAL_MS: '100',
  OUTBOX_RETRY_BASE_MS: '200',
  PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
  PENDING_REFERENCE_BASE_DELAY_MS: '200',
  PENDING_REFERENCE_MAX_DELAY_MS: '1000',
  PENDING_REFERENCE_MAX_ATTEMPTS: '4',
  DB_LOCK_TIMEOUT_MS: '2000',
  PORT: '0',
};

/** Unique queue names so test files never see each other's messages. */
export function queueEnv(prefix: string): Record<string, string> {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;
  return {
    SQS_WAGER_QUEUE: `${id}-wager.fifo`,
    SQS_WAGER_DLQ: `${id}-wager-dlq.fifo`,
    SQS_EVENTS_QUEUE: `${id}-events.fifo`,
  };
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...BASE_ENV, APP_ROLES: '', ...env });
}

let schemaReady: Promise<void> | undefined;
/** Applies pending migrations once per test process. */
export function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const orm = await MikroORM.init(ormOptions(testConfig()));
    await orm.getMigrator().up();
    await orm.close(true);
  })();
  return schemaReady;
}

/**
 * True when the process was killed abruptly. On POSIX that is SIGKILL; Windows
 * has no signals, so a killed process only shows up as a non-zero exit code.
 */
export const diedAbruptly = (proc: { signalCode: NodeJS.Signals | number | null; exitCode: number | null }) =>
  process.platform === 'win32' ? proc.exitCode !== 0 : proc.signalCode === 'SIGKILL';

export async function startTestApp(env: Record<string, string> = {}): Promise<RunningApp & { baseUrl: string }> {
  await ensureSchema();
  const app = await startApplication(testConfig({ APP_ROLES: 'api', ...env }));
  return { ...app, baseUrl: `http://127.0.0.1:${app.port}` };
}

// ---------------------------------------------------------------- HTTP helpers

export interface WalletInfo {
  id: string;
  playerId: string;
}

export async function createWallet(baseUrl: string, amount = '100.00', currency = 'BRL'): Promise<WalletInfo> {
  const playerId = randomUUID();
  const res = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return { id: body.id, playerId };
}

export interface WagerInput {
  wallet: WalletInfo;
  kind: string;
  amount: string;
  externalTransactionId?: string;
  reference?: string;
  providerId?: string;
  roundId?: string;
  currency?: string;
  idempotencyKey?: string;
}

export function wagerBody(input: WagerInput) {
  const providerId = input.providerId ?? 'provider-a';
  const externalTransactionId = input.externalTransactionId ?? `tx-${randomUUID()}`;
  return {
    idempotencyKey: input.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    body: {
      providerId,
      externalTransactionId,
      playerId: input.wallet.playerId,
      walletId: input.wallet.id,
      roundId: input.roundId ?? 'round-1',
      gameId: 'fortune-chimp',
      kind: input.kind,
      money: { amount: input.amount, currency: input.currency ?? 'BRL' },
      ...(input.reference ? { referenceExternalTransactionId: input.reference } : {}),
    },
  };
}

export async function submit(baseUrl: string, input: WagerInput) {
  const { idempotencyKey, body } = wagerBody(input);
  const res = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

export async function getJson(url: string) {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

// ----------------------------------------------------------------- SQS helpers

export function wagerMessage(input: WagerInput, messageId = `msg-${randomUUID()}`) {
  const { idempotencyKey, body } = wagerBody(input);
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey },
  };
}

/**
 * Sends a message. `dedupId` defaults to a random value so that SQS FIFO
 * de-duplication does NOT hide duplicates: the tests want them delivered.
 */
export async function sendMessage(
  sqs: SQSClient,
  queueUrl: string,
  message: { messageId: string; data?: { walletId?: string } } | Record<string, unknown>,
  options: { groupId?: string; dedupId?: string; raw?: string } = {},
) {
  const m = message as { data?: { walletId?: string } };
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: options.raw ?? JSON.stringify(message),
      MessageGroupId: options.groupId ?? m.data?.walletId ?? 'default',
      MessageDeduplicationId: options.dedupId ?? randomUUID(),
    }),
  );
}

/** Receives and deletes (FIFO groups block until in-flight messages are deleted). */
export async function drain(sqs: SQSClient, queueUrl: string, waitSeconds = 1): Promise<Message[]> {
  const out = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitSeconds,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['All'],
    }),
  );
  const messages = out.Messages ?? [];
  if (messages.length > 0) {
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
      }),
    );
  }
  return messages;
}

export async function testQueues(env: Record<string, string>): Promise<{ sqs: SQSClient; urls: QueueUrls }> {
  const config = testConfig(env);
  const sqs = createSqsClient(config);
  const urls = await new QueueRegistry(sqs, config).resolve();
  for (const url of Object.values(urls)) {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
  }
  return { sqs, urls };
}

// -------------------------------------------------------------- DB inspection

let inspector: MikroORM | undefined;
export async function db(): Promise<MikroORM> {
  await ensureSchema();
  inspector ??= await MikroORM.init(ormOptions(testConfig()));
  return inspector;
}

export async function sql<T = Record<string, any>>(query: string, params: unknown[] = []): Promise<T[]> {
  const orm = await db();
  return orm.em.fork({ useContext: false }).execute(query, params as any[]) as Promise<T[]>;
}

/**
 * The final invariant of every test: stored balance == balance rebuilt from
 * the ledger, and the last ledger entry explains the wallet version — for
 * every wallet in the database, not only the ones a test created.
 */
export async function assertGlobalConsistency(): Promise<void> {
  const broken = await sql(`
    select w.id, w.balance_amount::text as stored, coalesce(l.calc, 0)::text as calculated, w.version, l.last_version
      from wallets w
      left join (
        select wallet_id,
               sum(case when direction = 'CREDIT' then amount else -amount end) as calc,
               max(wallet_version) as last_version
          from wallet_ledger_entries group by wallet_id
      ) l on l.wallet_id = w.id
     where w.balance_amount <> coalesce(l.calc, 0)
        or (l.last_version is not null and l.last_version <> w.version)
        or (l.last_version is null and (w.version <> 1 or w.balance_amount <> 0))`);
  expect(broken).toEqual([]);
}

export async function walletState(walletId: string) {
  const [wallet] = await sql<{ balance: string; version: number }>(
    `select balance_amount::text as balance, version from wallets where id = ?`,
    [walletId],
  );
  const entries = await sql<{ direction: string; amount: string; transaction_id: string }>(
    `select direction, amount::text as amount, transaction_id from wallet_ledger_entries where wallet_id = ? order by wallet_version`,
    [walletId],
  );
  const transactions = await sql<{ status: string; kind: string; failure_code: string | null; external_transaction_id: string }>(
    `select status, kind, failure_code, external_transaction_id from wager_transactions where wallet_id = ? order by created_at, id`,
    [walletId],
  );
  return { wallet: wallet!, entries, transactions };
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 100, label = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ------------------------------------------------------ real child processes

export interface Instance {
  name: string;
  port: number;
  baseUrl: string;
  proc: ReturnType<typeof Bun.spawn>;
  kill(signal?: NodeJS.Signals): Promise<number | null>;
  output(): string;
}

/**
 * Asks the OS for a free port on all interfaces (the app listens on 0.0.0.0).
 * A fixed range could hit a port docker publishes on the host, such as
 * LocalStack's 4566; the OS hands out ephemeral ports that nothing else holds.
 */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
}

/** Spawns `bun src/main.ts` as a separate OS process (a real instance). */
export async function spawnInstance(name: string, env: Record<string, string>): Promise<Instance> {
  await ensureSchema();
  const port = await freePort();
  let buffer = '';
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, ...BASE_ENV, LOG_LEVEL: 'info', INSTANCE_ID: name, PORT: String(port), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) buffer += decoder.decode(chunk);
  };
  void collect(proc.stdout as ReadableStream<Uint8Array>);
  void collect(proc.stderr as ReadableStream<Uint8Array>);
  const baseUrl = `http://127.0.0.1:${port}`;
  const instance: Instance = {
    name,
    port,
    baseUrl,
    proc,
    output: () => buffer,
    async kill(signal = 'SIGTERM') {
      if (proc.exitCode === null && !proc.killed) proc.kill(signal);
      return proc.exited;
    },
  };
  const hasApi = (env.APP_ROLES ?? 'api').includes('api');
  await waitFor(
    async () => {
      if (proc.exitCode !== null) throw new Error(`${name} exited early:\n${buffer}`);
      if (!hasApi) return buffer.includes('instance started');
      try {
        const res = await fetch(`${baseUrl}/health/ready`);
        return res.status === 200;
      } catch {
        return false;
      }
    },
    { timeoutMs: 20_000, label: `${name} ready` },
  );
  return instance;
}
