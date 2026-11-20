/**
 * Load test — `bun run test:load`.
 *
 * Spawns N real instances (default 3), creates W wallets and fires R wager
 * requests over HTTP with C concurrent clients, round-robin across the
 * instances. A share of the requests targets a single "hot" wallet and a
 * share are deliberate duplicates (same Idempotency-Key). At the end it
 * checks the invariants (balance == ledger for every wallet), reads the
 * instances' Prometheus metrics and writes a Markdown report (and its title
 * strip) to docs/.
 *
 * Env: LOAD_INSTANCES, LOAD_WALLETS, LOAD_REQUESTS, LOAD_CONCURRENCY, LOAD_HOT_SHARE, LOAD_DUPLICATE_SHARE
 */
import { randomUUID } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { type Percentiles, renderLoadTestReport } from './load-test-report';
import {
  assertGlobalConsistency,
  createWallet,
  type Instance,
  queueEnv,
  spawnInstance,
  sql,
  submit,
  type WagerInput,
  type WalletInfo,
} from '../test/support/harness';

const N = Number(process.env.LOAD_INSTANCES ?? 3);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 200);
const REQUESTS = Number(process.env.LOAD_REQUESTS ?? 10_000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 64);
const HOT_SHARE = Number(process.env.LOAD_HOT_SHARE ?? 0.2);
const DUP_SHARE = Number(process.env.LOAD_DUPLICATE_SHARE ?? 0.1);

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

async function scrape(instances: Instance[], prefix: string): Promise<number> {
  let total = 0;
  for (const i of instances) {
    const text = await (await fetch(`${i.baseUrl}/metrics`)).text();
    for (const line of text.split('\n')) if (line.startsWith(prefix)) total += Number(line.split(' ').pop());
  }
  return total;
}

async function main() {
  const env = { ...queueEnv('load'), DB_POOL_MAX: '25', LOG_LEVEL: 'warn' };
  const instances: Instance[] = [];
  for (let i = 0; i < N; i++) instances.push(await spawnInstance(`load-${i}`, { ...env, LOG_LEVEL: 'warn' }).catch(async () => {
    // spawnInstance waits on readiness; LOG_LEVEL=warn hides the startup line for worker-only roles only
    throw new Error('instance failed to start');
  }));
  try {
    const wallets: WalletInfo[] = [];
    for (let i = 0; i < WALLETS; i++) wallets.push(await createWallet(instances[i % N]!.baseUrl, '1000.00'));
    const hot = await createWallet(instances[0]!.baseUrl, '1000.00');

    const sent: WagerInput[] = [];
    const latencies: number[] = [];
    const hotLatencies: number[] = [];
    const coldLatencies: number[] = [];
    const statuses = new Map<number, number>();
    let errors = 0;
    let cursor = 0;

    const next = (): WagerInput => {
      if (sent.length > 0 && Math.random() < DUP_SHARE) return sent[Math.floor(Math.random() * sent.length)]!;
      const wallet = Math.random() < HOT_SHARE ? hot : wallets[Math.floor(Math.random() * wallets.length)]!;
      const win = Math.random() < 0.3;
      const op: WagerInput = {
        wallet,
        kind: win ? 'WIN' : 'BET',
        amount: win ? '2.00' : '1.00',
        externalTransactionId: `load-${randomUUID()}`,
      };
      sent.push(op);
      return op;
    };

    const started = performance.now();
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (cursor < REQUESTS) {
          const n = cursor++;
          const t0 = performance.now();
          const op = next();
          try {
            const res = await submit(instances[n % N]!.baseUrl, op);
            statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
            if (res.status >= 500) errors++;
          } catch {
            errors++;
          }
          const ms = performance.now() - t0;
          latencies.push(ms);
          (op.wallet.id === hot.id ? hotLatencies : coldLatencies).push(ms);
        }
      }),
    );
    const elapsedS = (performance.now() - started) / 1000;

    // wait for the outbox to drain and measure how long it takes
    const drainStart = performance.now();
    for (;;) {
      const [row] = await sql<{ pending: number }>(`select count(*)::int as pending from outbox_messages where published_at is null`);
      if (row!.pending === 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const drainS = (performance.now() - drainStart) / 1000;
    await assertGlobalConsistency();

    latencies.sort((a, b) => a - b);
    hotLatencies.sort((a, b) => a - b);
    coldLatencies.sort((a, b) => a - b);
    const p = (xs: number[]): Percentiles => ({ p50: percentile(xs, 50), p95: percentile(xs, 95), p99: percentile(xs, 99), count: xs.length });

    const { markdown, svg } = renderLoadTestReport({
      generatedAt: new Date().toISOString(),
      instances: N,
      cpus: cpus().length,
      memoryGiB: totalmem() / 2 ** 30,
      wallets: WALLETS,
      requests: REQUESTS,
      concurrency: CONCURRENCY,
      hotShare: HOT_SHARE,
      duplicateShare: DUP_SHARE,
      elapsedS,
      all: p(latencies),
      regular: p(coldLatencies),
      hot: p(hotLatencies),
      maxMs: latencies[latencies.length - 1]!,
      errors,
      statuses: [...statuses.entries()].sort(([a], [b]) => a - b),
      replays: await scrape(instances, 'wager_duplicates_total'),
      lockConflicts: await scrape(instances, 'wallet_lock_conflicts_total'),
      retries: await scrape(instances, 'wager_retries_total'),
      drainS,
      lagS: await scrape(instances, 'outbox_lag_seconds'),
    });
    console.log(markdown);
    await Bun.write('docs/load-test-results.md', markdown);
    await Bun.write('docs/assets/load-test.svg', svg);
  } finally {
    await Promise.all(instances.map((i) => i.kill('SIGTERM')));
    process.exit(0);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
