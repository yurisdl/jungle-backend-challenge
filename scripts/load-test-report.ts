import { renderStrip } from './report-strip';

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  count: number;
}

/** Everything the load test measured; rendered into docs/load-test-results.md and its title strip. */
export interface LoadTestSummary {
  generatedAt: string;
  instances: number;
  cpus: number;
  memoryGiB: number;
  wallets: number;
  requests: number;
  concurrency: number;
  hotShare: number;
  duplicateShare: number;
  elapsedS: number;
  all: Percentiles;
  regular: Percentiles;
  hot: Percentiles;
  maxMs: number;
  errors: number;
  statuses: Array<[number, number]>;
  replays: number;
  lockConflicts: number;
  retries: number;
  drainS: number;
  lagS: number;
}

const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const pct = (share: number) => `${Math.round(share * 100)}%`;
const lat = (p: Percentiles) => `${p.p50.toFixed(1)} / ${p.p95.toFixed(1)} / ${p.p99.toFixed(1)} ms`;

export function renderLoadTestReport(s: LoadTestSummary): { markdown: string; svg: string } {
  const svg = renderStrip({
    title: 'Teste de carga',
    subtitle: `${s.instances} instâncias, uma hot wallet e ${pct(s.duplicateShare)} de requisições repetidas.`,
    slipTitle: 'RESULTADO',
    rows: [
      ['requisições', grouped(s.requests)],
      ['erros', String(s.errors)],
      ['p95 wallets comuns', `${s.regular.p95.toFixed(0)} ms`],
      ['saldo = Σ ledger', 'todas'],
    ],
    description: `Faixa de título do relatório de carga com um bilhete resumindo o resultado: ${grouped(s.requests)} requisições, ${s.errors} erros, p95 de ${s.regular.p95.toFixed(0)} ms nas wallets comuns e saldo igual ao ledger em todas as wallets.`,
  });

  const markdown = `<p align="center">
  <img src="assets/load-test.svg" width="100%" alt="Teste de carga: ${grouped(s.requests)} requisições, ${s.errors} erros, p95 de ${s.regular.p95.toFixed(0)} ms nas wallets comuns, saldo igual ao ledger em todas as wallets.">
</p>

<sub>Gerado por \`bun run test:load\` em ${s.generatedAt}. Voltar ao [README](../README.md).</sub>

## Ambiente

- ${s.instances} instâncias da aplicação (processos Bun separados, todos os papéis), PostgreSQL 16 e LocalStack em Docker na mesma máquina
- Máquina: ${s.cpus} vCPU e ${s.memoryGiB.toFixed(1)} GiB de RAM, com o gerador de carga rodando nela também
- Pool de 25 conexões por instância e \`lock_timeout\` de 2 s

## Metodologia

- ${s.wallets} wallets e 1 hot wallet, todas abertas com 1000.00 BRL
- ${grouped(s.requests)} requisições HTTP de ${s.concurrency} clientes simultâneos, alternando entre as instâncias
- Mistura de 70% \`BET 1.00\` e 30% \`WIN 2.00\`; ${pct(s.hotShare)} das operações novas vão para a hot wallet e ${pct(s.duplicateShare)} das requisições repetem uma anterior (mesma \`Idempotency-Key\`)
- Depois da carga, o teste espera a outbox esvaziar e confere \`balance == Σ ledger\` em todas as wallets do banco

## Resultado

| Métrica | Valor |
|---|---|
| duração | ${s.elapsedS.toFixed(1)} s |
| vazão | ${(s.requests / s.elapsedS).toFixed(0)} req/s |
| latência p50 / p95 / p99, todas | ${lat(s.all)} |
| latência p50 / p95 / p99, wallets comuns (${s.regular.count} req) | ${lat(s.regular)} |
| latência p50 / p95 / p99, hot wallet (${s.hot.count} req) | ${lat(s.hot)} |
| latência máxima | ${s.maxMs.toFixed(1)} ms |
| taxa de erro (5xx ou rede) | ${((s.errors / s.requests) * 100).toFixed(2)}% (${s.errors}) |
| status HTTP | ${s.statuses.map(([code, n]) => `${code}: ${n}`).join(', ')} |
| duplicatas detectadas (replays) | ${s.replays} |
| conflitos de lock (timeouts, corridas, deadlocks) | ${s.lockConflicts} |
| retries de transação | ${s.retries} |
| outbox esvaziada após a carga | ${s.drainS.toFixed(1)} s (atraso medido no fim: ${s.lagS.toFixed(1)} s) |
| saldo == ledger | ✅ todas as wallets |

## Como ler os números

- \`201\` é processada, \`200\` é replay idempotente e \`422\` é rejeição de negócio (saldo insuficiente na hot wallet).
- A hot wallet é o gargalo por desenho: toda operação nela segura o mesmo lock de linha, então a vazão dela é de uma transação por vez (≈ 1 / tempo de lock). As requisições dela esperam em fila, primeiro no bulkhead da instância e depois no lock, e é isso que puxa o p95 e o p99 gerais. As wallets comuns não ficam mais lentas porque o bulkhead impede que a hot wallet tome o pool de conexões.
- O gerador é de malha fechada: clientes presos em requisições da hot wallet não enviam outras, então a vazão global também é limitada pela fatia da hot wallet. Um teste de malha aberta mostraria a capacidade das wallets comuns.

> [!NOTE]
> Gerador, ${s.instances} instâncias, PostgreSQL e LocalStack dividem a mesma máquina e as mesmas CPUs. Os números são um piso, não uma medida de capacidade.
`;
  return { markdown, svg };
}
