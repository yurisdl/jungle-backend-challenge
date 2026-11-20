/**
 * Guided demo — `bun run demo`.
 *
 * Spawns three real instances of the service (separate OS processes sharing
 * PostgreSQL and SQS) and walks through the scenarios that matter most,
 * printing what is sent, what comes back and what ends up in the database:
 *
 *   1. the challenge's mandatory case: 100 BRL, two parallel bets of 80;
 *   2. 50 identical requests in parallel across instances: one debit;
 *   3. a ROLLBACK that arrives before its BET: 202, then settled;
 *   4. a consumer killed after the commit and before the SQS ack;
 *   5. reconciliation of every wallet and an excerpt of the metrics.
 *
 * Needs the infrastructure up (`bun run infra:up`) and migrations applied.
 */
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import type { QueueUrls } from '../src/infrastructure/sqs/sqs';
import {
  assertGlobalConsistency,
  createWallet,
  getJson,
  type Instance,
  queueEnv,
  sendMessage,
  spawnInstance,
  submit,
  testQueues,
  waitFor,
  wagerMessage,
  walletState,
  type WalletInfo,
} from '../test/support/harness';

const color = (code: number) => (s: string | number) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = color(1);
const dim = color(2);
const green = color(32);
const red = color(31);
const yellow = color(33);
const cyan = color(36);

const say = (s = '') => console.log(s);
const ok = (s: string) => say(`  ${green('✔')} ${s}`);
const fail = (s: string) => {
  say(`  ${red('✘')} ${s}`);
  process.exitCode = 1;
};
const check = (cond: boolean, s: string) => (cond ? ok(s) : fail(s));
const step = (n: number, title: string, why: string) => {
  say();
  say(bold(cyan(`━━ ${n}. ${title}`)));
  say(dim(`   ${why}`));
};
const statusColor = (s: number) => (s >= 500 ? red(s) : s >= 400 ? yellow(s) : green(s));

const instances: Instance[] = [];
const alive = (i: Instance) => i.proc.exitCode === null && i.proc.signalCode === null;
const wallets: WalletInfo[] = [];
let sqs: SQSClient;
let urls: QueueUrls;

async function balanceOf(w: WalletInfo) {
  return (await walletState(w.id)).wallet;
}

async function queueDepth(url: string) {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(out.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

async function metricSum(list: Instance[], name: string): Promise<number> {
  let total = 0;
  for (const i of list) {
    if (!alive(i)) continue;
    const text = await (await fetch(`${i.baseUrl}/metrics`)).text();
    for (const line of text.split('\n')) if (line.startsWith(name)) total += Number(line.split(' ').pop());
  }
  return total;
}

async function newWallet(api: Instance, amount: string) {
  const w = await createWallet(api.baseUrl, amount);
  wallets.push(w);
  return w;
}

// ------------------------------------------------------------------ scenarios

async function mandatoryScenario([a, b]: Instance[]) {
  step(1, 'Cenário obrigatório: saldo 100, duas apostas de 80 em paralelo', 'Cada aposta vai para uma instância diferente, ao mesmo tempo.');
  const w = await newWallet(a!, '100.00');
  say(`   carteira ${dim(w.id)} criada com 100.00 BRL`);
  const results = await Promise.all(
    [a!, b!].map((inst) => submit(inst.baseUrl, { wallet: w, kind: 'BET', amount: '80.00', externalTransactionId: `demo-bet-${randomUUID()}` })),
  );
  results.forEach((r, i) => {
    const detail = r.body.failureCode ? `${r.body.status} (${r.body.failureCode})` : r.body.status;
    say(`   aposta ${i + 1} → ${[a, b][i]!.name}: HTTP ${statusColor(r.status)} ${detail}`);
  });
  const statuses = results.map((r) => r.status).sort();
  const { balance, version } = await balanceOf(w);
  check(statuses[0] === 201 && statuses[1] === 422, 'exatamente uma aposta aprovada e a outra recusada por saldo insuficiente');
  check(balance === '20.00', `saldo final ${balance} BRL, nunca negativo (versão ${version})`);
}

async function idempotencyScenario(all: Instance[]) {
  step(2, '50 requisições idênticas em paralelo nas três instâncias', 'Mesma Idempotency-Key, como um provedor que reenvia por timeout.');
  const w = await newWallet(all[0]!, '100.00');
  const ext = `demo-dup-${randomUUID()}`;
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => submit(all[i % all.length]!.baseUrl, { wallet: w, kind: 'BET', amount: '10.00', externalTransactionId: ext })),
  );
  const count = (s: number) => results.filter((r) => r.status === s).length;
  say(`   respostas em ${Date.now() - started} ms: ${green(count(201))}× 201 (processada) e ${green(count(200))}× 200 (replay da mesma resposta)`);
  const ids = new Set(results.map((r) => r.body.transactionId));
  const state = await walletState(w.id);
  const debits = state.entries.filter((e) => e.direction === 'DEBIT').length;
  check(count(201) === 1 && count(200) === 49, 'uma única execução, as outras 49 devolvem a resposta original');
  check(ids.size === 1 && !ids.has(undefined), 'todas as respostas apontam para a mesma transação');
  check(debits === 1 && state.wallet.balance === '90.00', `um único débito no ledger, saldo ${state.wallet.balance} BRL`);
}

async function outOfOrderScenario([a, b, c]: Instance[]) {
  step(3, 'ROLLBACK chega antes da aposta que ele desfaz', 'Entrega fora de ordem: a referência ainda não existe.');
  const w = await newWallet(a!, '100.00');
  const betId = `demo-late-bet-${randomUUID()}`;
  const rollback = await submit(b!.baseUrl, { wallet: w, kind: 'ROLLBACK', amount: '30.00', reference: betId });
  say(`   ROLLBACK → HTTP ${statusColor(rollback.status)} ${rollback.body.status}`);
  check(rollback.status === 202 && rollback.body.status === 'PENDING_REFERENCE', 'aceito e guardado como pendente, sem mexer no saldo');

  const bet = await submit(c!.baseUrl, { wallet: w, kind: 'BET', amount: '30.00', externalTransactionId: betId });
  say(`   BET de 30.00 chega depois → HTTP ${statusColor(bet.status)} ${bet.body.status}`);
  const settled = await waitFor(
    async () => {
      const r = await getJson(`${a!.baseUrl}/wagering/transactions/${rollback.body.transactionId}`);
      return r.body.status === 'PROCESSED' ? r.body : false;
    },
    { label: 'pending rollback settled', timeoutMs: 15_000 },
  );
  const { balance, version } = await balanceOf(w);
  say(`   o worker de pendências reprocessou o ROLLBACK: ${settled.status}`);
  check(balance === '100.00', `aposta debitada e estornada, saldo de volta a ${balance} BRL (versão ${version})`);
}

async function crashScenario(api: Instance, env: Record<string, string>) {
  step(4, 'Instância morre depois do commit e antes do ack no SQS', 'Falha injetada (FAULT_INJECTION=crash-after-commit) num consumidor isolado.');
  // a consumer-only instance has no HTTP port: it reports readiness through its "instance started" log line
  const crashing = await spawnInstance('consumer-crash', { ...env, LOG_LEVEL: 'info', APP_ROLES: 'consumer', FAULT_INJECTION: 'crash-after-commit' });
  instances.push(crashing);
  const w = await newWallet(api, '100.00');
  const msg = wagerMessage({ wallet: w, kind: 'BET', amount: '40.00', externalTransactionId: `demo-crash-${randomUUID()}` });
  await sendMessage(sqs, urls.wager, msg);
  say(`   mensagem ${dim(msg.messageId)} enviada para a fila`);

  await crashing.proc.exited;
  say(`   ${crashing.name} morreu com ${red(String(crashing.proc.signalCode))} logo após o COMMIT`);
  const after = await balanceOf(w);
  check(after.balance === '60.00', `o débito foi gravado (saldo ${after.balance}) e a mensagem continua na fila (${await queueDepth(urls.wager)} mensagem)`);

  const healthy = await spawnInstance('consumer-healthy', { ...env, APP_ROLES: 'api,consumer' });
  instances.push(healthy);
  say(`   ${healthy.name} assume; o SQS reentrega após o visibility timeout…`);
  await waitFor(async () => (await queueDepth(urls.wager)) === 0, { label: 'redelivery acked', timeoutMs: 30_000, intervalMs: 250 });
  const state = await walletState(w.id);
  const duplicates = await metricSum([healthy], 'wager_duplicates_total{source="sqs",type="inbox"}');
  check(
    state.entries.filter((e) => e.direction === 'DEBIT').length === 1 && state.wallet.balance === '60.00',
    `a reentrega foi absorvida pelo inbox: um débito só, saldo ${state.wallet.balance} BRL`,
  );
  check(duplicates === 1, `wager_duplicates_total{source="sqs",type="inbox"} = ${duplicates}`);
}

async function reconciliationScenario(started: Instance[]) {
  step(5, 'Reconciliação e métricas', 'Saldo gravado comparado ao saldo recalculado a partir do ledger.');
  const all = started.filter(alive);
  let consistent = 0;
  for (const [i, w] of wallets.entries()) {
    const r = await fetch(`${all[i % all.length]!.baseUrl}/wallets/${w.id}/reconciliation`, { method: 'POST' });
    const body = (await r.json()) as { consistent: boolean; storedBalance: { amount: string }; checkedEntries: number };
    say(`   ${dim(w.id)} saldo ${body.storedBalance.amount.padStart(6)} · ${String(body.checkedEntries).padStart(2)} lançamentos · ${body.consistent ? green('consistente') : red('DIVERGENTE')}`);
    if (body.consistent) consistent++;
  }
  check(consistent === wallets.length, `${consistent}/${wallets.length} carteiras da demo consistentes`);
  await assertGlobalConsistency();
  ok('verificação global no banco: saldo = Σ ledger e versão = última entrada, para todas as carteiras');

  say();
  say(dim(`   métricas somadas das ${all.length} instâncias vivas (GET /metrics):`));
  for (const name of [
    'wager_transactions_total',
    'wager_duplicates_total',
    'wager_idempotency_conflicts_total',
    'wallet_lock_conflicts_total',
    'wager_retries_total',
    'outbox_published_total',
    'wallet_reconciliation_divergences_total',
  ]) {
    say(`   ${name.padEnd(42)} ${await metricSum(all, name)}`);
  }
}

// ------------------------------------------------------------------------ main

async function main() {
  say(bold('Wagering Processor · demonstração'));
  const env = { ...queueEnv('demo'), LOG_LEVEL: 'warn' };
  ({ sqs, urls } = await testQueues(env));
  say(dim('   subindo três instâncias (processos separados, mesmo PostgreSQL e SQS)…'));
  const roles = { APP_ROLES: 'api,outbox,pending-reference' };
  const trio: Instance[] = [];
  for (const name of ['instance-a', 'instance-b', 'instance-c']) {
    const inst = await spawnInstance(name, { ...env, ...roles });
    trio.push(inst);
    instances.push(inst);
  }
  say(`   ${trio.map((i) => `${i.name} ${dim(i.baseUrl)}`).join(' · ')}`);

  await mandatoryScenario(trio);
  await idempotencyScenario(trio);
  await outOfOrderScenario(trio);
  await crashScenario(trio[0]!, env);
  await reconciliationScenario(instances);

  say();
  say(process.exitCode ? bold(red('Alguma verificação falhou.')) : bold(green('Tudo certo.')));
}

main()
  .catch((error) => {
    console.error(red(String(error?.stack ?? error)));
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all(instances.map((i) => i.kill('SIGTERM')));
    process.exit(process.exitCode ?? 0);
  });
