<p align="center">
  <img src="docs/assets/hero.svg" width="100%" alt="Bilhete de aposta sendo impresso: saldo 100.00, duas apostas de 80.00 em paralelo em instâncias diferentes, uma aceita e outra recusada por saldo insuficiente, 49 reenvios devolvidos como replay, saldo final 20.00 igual à soma do ledger.">
</p>

<p align="center">
  <a href="https://github.com/yurisdl/jungle-backend-challenge/actions/workflows/ci.yml"><img src="https://github.com/yurisdl/jungle-backend-challenge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Bun-1.4-0E3B2E?style=flat-square&labelColor=1E2622" alt="Bun 1.4">
  <img src="https://img.shields.io/badge/TypeScript-strict-0E3B2E?style=flat-square&labelColor=1E2622" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/NestJS-10-0E3B2E?style=flat-square&labelColor=1E2622" alt="NestJS 10">
  <img src="https://img.shields.io/badge/PostgreSQL-16-0E3B2E?style=flat-square&labelColor=1E2622" alt="PostgreSQL 16">
  <img src="https://img.shields.io/badge/MikroORM-6-0E3B2E?style=flat-square&labelColor=1E2622" alt="MikroORM 6">
  <img src="https://img.shields.io/badge/SQS-LocalStack-0E3B2E?style=flat-square&labelColor=1E2622" alt="SQS via LocalStack">
  <img src="https://img.shields.io/badge/testes-136-C79A3A?style=flat-square&labelColor=1E2622" alt="136 testes">
</p>

Serviço que recebe transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de vários provedores, por HTTP e por SQS, e mantém o saldo de cada jogador exato quando as mensagens chegam duplicadas, fora de ordem, ao mesmo tempo e em várias instâncias.

O bilhete acima é o cenário obrigatório do desafio: saldo de 100.00 e duas apostas de 80.00 chegando juntas em instâncias diferentes. Uma passa, a outra é recusada, e os 49 reenvios da primeira devolvem a mesma resposta sem tocar no saldo. É o que `bun run demo` imprime no seu terminal.

<table>
  <tr>
    <td><a href="./ARCHITECTURE.md"><b>Arquitetura e decisões</b></a><br><sub>como cada garantia é obtida, trade-offs e limitações</sub></td>
    <td><a href="./docs/load-test-results.md"><b>Teste de carga</b></a><br><sub>10 000 requisições em 3 instâncias, 0 erros</sub></td>
    <td><a href="./.github/workflows/ci.yml"><b>CI</b></a><br><sub>todas as suítes contra PostgreSQL e LocalStack reais</sub></td>
  </tr>
</table>

## O que nunca acontece

| Nunca | Por quê | Onde está provado |
|---|---|---|
| saldo negativo | `SELECT … FOR UPDATE` na wallet e `CHECK (balance_amount >= 0)` no banco | `test/concurrency/hot-wallet.test.ts` |
| a mesma aposta debitada duas vezes | `Idempotency-Key` com hash do payload, inbox por mensagem e `UNIQUE` no banco | `hot-wallet.test.ts`, `sqs-consumer.test.ts` |
| saldo que o ledger não explica | *constraint trigger* adiada para o commit compara a wallet com o último lançamento | `test/integration/schema.test.ts` |
| reversão aplicada duas vezes | índice único parcial por referência | `schema.test.ts`, `wager-properties.test.ts` |
| aposta paga e estornada | `WIN` de aposta estornada e estorno de aposta já paga são recusados | `wager-rules.test.ts`, `wager-properties.test.ts` |
| evento perdido ou publicado sem commit | outbox gravada na mesma transação do saldo | `test/integration/outbox.test.ts` |
| eventos de uma wallet fora de ordem | publisher reivindica a wallet com advisory lock e para no primeiro evento recusado | `test/integration/outbox.test.ts` |
| débito repetido quando a instância morre antes do ack | inbox gravada junto com o débito; a reentrega só é confirmada | `test/concurrency/multi-instance.test.ts` |
| `500` quando o PostgreSQL cai | timeouts no cliente; conexão perdida vira `503` com `Retry-After` | `test/resilience/infra-outage.test.ts` |

## Em um minuto

```bash
bun install && bun run infra:up && bun run migrate
bun run demo
```

A demonstração sobe três instâncias reais (processos separados, mesmo PostgreSQL e SQS) e verifica cada passo:

1. saldo 100.00 e duas apostas de 80.00 em paralelo em instâncias diferentes: uma `201`, outra `422 INSUFFICIENT_FUNDS`, saldo 20.00;
2. 50 requisições idênticas nas três instâncias: uma `201`, 49 replays `200`, um único débito;
3. um `ROLLBACK` que chega antes da aposta: `202 PENDING_REFERENCE`, processado quando a aposta aparece;
4. um consumidor morto com `SIGKILL` depois do commit e antes do ack no SQS: a reentrega é absorvida pelo inbox;
5. reconciliação de todas as wallets e um resumo das métricas Prometheus.

<details>
<summary>Saída da demonstração</summary>

```text
━━ 1. Cenário obrigatório: saldo 100, duas apostas de 80 em paralelo
   aposta 1 → instance-a: HTTP 201 PROCESSED
   aposta 2 → instance-b: HTTP 422 REJECTED (INSUFFICIENT_FUNDS)
  ✔ exatamente uma aposta aprovada e a outra recusada por saldo insuficiente
  ✔ saldo final 20.00 BRL, nunca negativo (versão 2)

━━ 2. 50 requisições idênticas em paralelo nas três instâncias
   respostas em 191 ms: 1× 201 (processada) e 49× 200 (replay da mesma resposta)
  ✔ um único débito no ledger, saldo 90.00 BRL

━━ 3. ROLLBACK chega antes da aposta que ele desfaz
   ROLLBACK → HTTP 202 PENDING_REFERENCE
   BET de 30.00 chega depois → HTTP 201 PROCESSED
  ✔ aposta debitada e estornada, saldo de volta a 100.00 BRL (versão 3)

━━ 4. Instância morre depois do commit e antes do ack no SQS
   consumer-crash morreu com SIGKILL logo após o COMMIT
  ✔ o débito foi gravado (saldo 60.00) e a mensagem continua na fila (1 mensagem)
  ✔ a reentrega foi absorvida pelo inbox: um débito só, saldo 60.00 BRL

━━ 5. Reconciliação e métricas
  ✔ 4/4 carteiras da demo consistentes
  ✔ verificação global no banco: saldo = Σ ledger e versão = última entrada, para todas as carteiras
```

</details>

## Como funciona

Toda transação, venha por HTTP ou pela fila, passa pelo mesmo caso de uso e vira **uma única transação SQL**: inbox, transação, saldo, ledger e eventos são confirmados juntos ou não são confirmados. Qualquer número de instâncias pode rodar lado a lado, porque nenhuma guarda estado entre requisições.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"primaryColor": "#0E3B2E", "primaryTextColor": "#EDEFE6", "primaryBorderColor": "#C79A3A", "lineColor": "#6F8077", "clusterBkg": "transparent", "clusterBorder": "#A57E2A", "titleColor": "#A57E2A", "edgeLabelBackground": "#0E3B2E"}}}%%
flowchart LR
  HTTP["Provedor via HTTP<br/>Idempotency-Key"]
  QUEUE[("wager-transactions.fifo")]
  subgraph INST["cada instância (APP_ROLES)"]
    API["API NestJS"]
    CON["Consumidor SQS<br/>ack só após o commit"]
    USE{{"SubmitWagerTransaction"}}
    PEND["Worker de referências<br/>pendentes"]
    PUB["Publisher da outbox"]
  end
  DB[("PostgreSQL<br/>wallets, ledger, transações,<br/>inbox, outbox")]
  EVENTS[("wagering-events.fifo")]
  DLQ[("DLQ")]

  HTTP --> API --> USE
  QUEUE --> CON --> USE
  CON -. erro permanente .-> DLQ
  USE == "uma transação SQL" ==> DB
  PEND -- "backoff exponencial" --> DB
  PUB -- "lock por wallet" --> DB
  PUB --> EVENTS
```

O caminho de uma aposta, do pedido ao evento:

```mermaid
%%{init: {"theme": "base", "themeVariables": {"actorBkg": "#0E3B2E", "actorTextColor": "#EDEFE6", "actorBorder": "#C79A3A", "actorLineColor": "#6F8077", "signalColor": "#6F8077", "signalTextColor": "#6F8077", "noteBkgColor": "#EDEFE6", "noteTextColor": "#1E2622", "noteBorderColor": "#C79A3A", "sequenceNumberColor": "#EDEFE6"}}}%%
sequenceDiagram
  autonumber
  participant P as Provedor
  participant I as Instância
  participant DB as PostgreSQL
  participant Q as Outbox e SQS
  P->>I: POST com Idempotency-Key
  I->>DB: key já vista? replay ou 409
  I->>DB: SELECT wallet FOR UPDATE
  I->>DB: relê a key sob o lock
  Note over I: settleWager (regra pura)
  I->>DB: saldo WHERE version, ledger, outbox
  DB-->>I: COMMIT (trigger: saldo = ledger)
  I-->>P: 201 PROCESSED
  Q->>DB: reivindica a wallet (advisory lock)
  Q->>Q: publica, dedup por eventId
```

O porquê de cada escolha, as interpretações das regras e o que ficou de fora estão em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Rodar

### Tudo com Docker Compose

```bash
docker compose up -d --build --scale app=3
```

Sobe PostgreSQL, LocalStack (filas criadas por `docker/localstack/init-sqs.sh`), roda as migrations e **três instâncias** nas portas `3000`, `3001` e `3002`. Todas executam API, consumidor SQS, publisher da outbox e worker de referências pendentes.

```bash
curl localhost:3000/health/ready   # {"status":"up","checks":{"postgres":"up","sqs":"up"}}
docker compose down -v             # derruba e apaga os volumes
```

### Fora de container

Requer Docker com Compose v2 e Bun ≥ 1.3.

```bash
bun install
bun run infra:up      # PostgreSQL + LocalStack
bun run migrate       # aplica as migrations (bun run migrate:down reverte a última)
bun run start         # uma instância em :3000 com todos os papéis
```

Para várias instâncias locais, use portas e papéis diferentes:

```bash
PORT=3001 bun run start
PORT=3002 APP_ROLES=consumer,outbox bun run start   # só workers
```

## Testes

Os testes de integração, concorrência e resiliência usam **PostgreSQL e LocalStack reais** (`bun run infra:up` antes). Nada é mockado.

| Comando | O que cobre |
|---|---|
| `bun run test` | tudo, exceto resiliência (≈ 1 min) |
| `bun run test:unit` | domínio: `Money`, `Wallet`, regras de `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`, hash, propriedades |
| `bun run test:properties` | property-based (fast-check): históricos aleatórios, fora de ordem e duplicados |
| `bun run test:integration` | constraints e migrations, API, SQS (inbox, retry, DLQ), outbox |
| `bun run test:concurrency` | paralelismo real, hot wallet, 3+ processos, crash e restart |
| `bun run test:resilience` | derruba o PostgreSQL e congela o SQS de verdade, sob carga |
| `bun run test:load` | teste de carga, gera [`docs/load-test-results.md`](./docs/load-test-results.md) |
| `bun run typecheck` | TypeScript estrito |

> [!NOTE]
> Os testes de resiliência param os containers `wagering-processor-postgres-1` e `wagering-processor-localstack-1` (`docker kill` e `docker pause`) e os restauram ao final, por isso só rodam com `test:resilience`. Se os containers tiverem outro nome, use `POSTGRES_CONTAINER` e `LOCALSTACK_CONTAINER`.

A [CI](./.github/workflows/ci.yml) roda typecheck, todas as suítes (inclusive resiliência) contra PostgreSQL e LocalStack reais e o build da imagem Docker, a cada push e pull request. O mapa "cenário obrigatório → teste" está em [`ARCHITECTURE.md` §14](./ARCHITECTURE.md#14-testes).

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet (saldo inicial > 0 gera `OPENING` + `CREDIT` na mesma transação) |
| `GET` | `/wallets/:walletId` | wallet e saldo |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | ledger, mais recente primeiro, cursor opaco e estável |
| `POST` | `/wallets/:walletId/reconciliation` | recalcula o saldo pelo ledger e sinaliza divergências |
| `POST` | `/wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | transação por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |
| `GET` | `/health/live`, `/health/ready` | liveness e readiness (PostgreSQL + SQS), públicos |
| `GET` | `/metrics` | métricas Prometheus |

### Códigos HTTP (iguais em todos os endpoints)

| Situação | Status | Reenviar? |
|---|---|---|
| processada (primeira vez) | `201` | não |
| replay idempotente (mesma key, mesmo payload) | `200` + `idempotentReplay: true` | não |
| aceita, aguardando referência (`PENDING_REFERENCE`) | `202` | não; consultar depois |
| payload, header ou cursor inválido | `400` | não, corrigir |
| wallet (no path ou no body) inexistente | `404` | não |
| conflito de idempotência, `externalTransactionId` reutilizado, wallet duplicada | `409` | não |
| rejeição de negócio persistida (`REJECTED` + `failureCode`) | `422` | não, é final |
| falha transitória (banco indisponível, lock timeout) | `503` + `Retry-After` | **sim, igual** |
| falha interna permanente (`FAILED`) | `500` | não |

> [!TIP]
> `503` é o único status que pede reenvio, e o reenvio deve usar a mesma `Idempotency-Key`. Erros têm o formato `{"error":{"code":"…","message":"…","retryable":false}}`; rejeições de negócio retornam o resultado da transação (`transactionId`, `status`, `failureCode`, `balance`).

<details>
<summary>Exemplo por HTTP</summary>

```bash
curl -s -XPOST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -XPOST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
# 201 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

</details>

<details>
<summary>Exemplo por SQS</summary>

Fila `wager-transactions.fifo`, DLQ `wager-transactions-dlq.fifo`, eventos publicados em `wagering-events.fifo`.

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124",
    "playerId":"…","walletId":"…","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
    "money":{"amount":"25.00","currency":"BRL"}}}'
```

</details>

## Configuração

<details>
<summary>Variáveis de ambiente</summary>

| Variável | Padrão | Uso |
|---|---|---|
| `APP_ROLES` | `api,consumer,outbox,pending-reference` | papéis desta instância |
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | `postgresql://wagering:wagering@localhost:5432/wagering` | PostgreSQL |
| `DB_POOL_MAX` | `20` | conexões por instância |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima por lock de linha (vira `503`/retry) |
| `DB_STATEMENT_TIMEOUT_MS` | `15000` | limite por comando SQL; o cliente desiste 2 s depois disso se o servidor não responder |
| `DB_CONNECT_TIMEOUT_MS` / `DB_ACQUIRE_TIMEOUT_MS` | `3000` / `5000` | abrir conexão / esperar uma conexão livre do pool |
| `SQS_ENDPOINT` | `http://localhost:4566` | LocalStack |
| `SQS_AUTO_CREATE_QUEUES` | `true` | cria filas (com redrive para a DLQ) se não existirem |
| `SQS_MAX_RECEIVE_COUNT` | `5` | tentativas antes da DLQ |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | visibilidade das mensagens |
| `SQS_REQUEST_TIMEOUT_MS` | `5000` | limite de cada chamada ao SQS (somado ao long poll no receive) |
| `PENDING_REFERENCE_BASE_DELAY_MS` / `_MAX_DELAY_MS` / `_MAX_ATTEMPTS` | `2000` / `300000` / `10` | backoff de referências ausentes (~17 min no total) |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_POLL_INTERVAL_MS` | `50` / `500` | publisher da outbox |
| `LOG_LEVEL` | `info` | nível dos logs JSON |

</details>

## Estrutura

```
src/
  domain/            Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos, settleWager (regras puras)
  application/       casos de uso, portas (repositórios, relógio, ids, métricas, logger), erros, hash canônico
  infrastructure/    MikroORM (EntitySchema, migrations, repositórios), SQS (consumer, filas), workers, observabilidade
  interfaces/http/   controllers NestJS, mapeamento de erros, guard de autenticação (ponto de extensão)
test/
  unit/  integration/  concurrency/  resilience/  support/ (harness, geradores do fast-check)
scripts/             migrate.ts, load-test.ts, demo.ts
docs/                relatório de carga e as imagens deste README
.github/workflows/   ci.yml
```
