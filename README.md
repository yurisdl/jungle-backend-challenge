# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de múltiplos provedores, por HTTP e por SQS, mantendo-se correto com mensagens duplicadas, fora de ordem, concorrentes e com várias instâncias rodando ao mesmo tempo.

- **Stack:** Bun 1.x · TypeScript estrito · NestJS (só a camada HTTP) · PostgreSQL 16 · MikroORM 6 · AWS SQS via LocalStack · Docker Compose
- **Decisões, trade-offs e limitações:** [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Teste de carga:** [`docs/load-test-results.md`](./docs/load-test-results.md)

## Requisitos

- Docker com Docker Compose v2
- Bun ≥ 1.3 (só para rodar fora de container e para os testes)

## Subir tudo com Docker Compose

```bash
docker compose up -d --build --scale app=3
```

Isso sobe PostgreSQL, LocalStack (filas criadas por `docker/localstack/init-sqs.sh`), roda as migrations (`migrate`) e **três instâncias** da aplicação nas portas `3000`, `3001` e `3002`. Todas as instâncias executam API, consumidor SQS, publisher da outbox e worker de referências pendentes.

```bash
curl localhost:3000/health/ready   # {"status":"up","checks":{"postgres":"up","sqs":"up"}}
docker compose down -v             # derruba e apaga os volumes
```

## Rodar localmente (fora de container)

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

Os testes de integração e concorrência usam **PostgreSQL e LocalStack reais** (`bun run infra:up` antes). Nada é mockado.

```bash
bun run test               # tudo (≈ 1 min)
bun run test:unit          # domínio: Money, Wallet, regras de BET/WIN/LOSS/REFUND/ROLLBACK, hash
bun run test:integration   # constraints e migrations, API, SQS (inbox, retry, DLQ), outbox
bun run test:concurrency   # paralelismo real, hot wallet, 3+ processos, crash e restart
bun run test:load          # teste de carga (gera docs/load-test-results.md)
bun run typecheck
```

O mapa "cenário obrigatório → teste" está em [`ARCHITECTURE.md` §14](./ARCHITECTURE.md#14-testes).

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

### Exemplo

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

### Códigos HTTP (iguais em todos os endpoints)

| Situação | Status | Reenviar? |
|---|---|---|
| processada (primeira vez) | `201` | — |
| replay idempotente (mesma key, mesmo payload) | `200` + `idempotentReplay: true` | — |
| aceita, aguardando referência (`PENDING_REFERENCE`) | `202` | não; consultar depois |
| payload/header/cursor inválido | `400` | não, corrigir |
| wallet (no path ou no body) inexistente | `404` | não |
| conflito de idempotência, `externalTransactionId` reutilizado, wallet duplicada | `409` | não |
| rejeição de negócio persistida (`REJECTED` + `failureCode`) | `422` | não, é final |
| falha transitória (banco indisponível, lock timeout) | `503` + `Retry-After` | **sim, igual** |
| falha interna permanente (`FAILED`) | `500` | não |

Erros têm o formato `{"error":{"code":"…","message":"…","retryable":false}}`. Rejeições de negócio retornam o resultado da transação (`transactionId`, `status`, `failureCode`, `balance`).

### Mensagem SQS

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

## Configuração

| Variável | Padrão | Uso |
|---|---|---|
| `APP_ROLES` | `api,consumer,outbox,pending-reference` | papéis desta instância |
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | `postgresql://wagering:wagering@localhost:5432/wagering` | PostgreSQL |
| `DB_POOL_MAX` | `20` | conexões por instância |
| `DB_LOCK_TIMEOUT_MS` | `5000` | espera máxima por lock de linha (vira `503`/retry) |
| `SQS_ENDPOINT` | `http://localhost:4566` | LocalStack |
| `SQS_AUTO_CREATE_QUEUES` | `true` | cria filas (com redrive para a DLQ) se não existirem |
| `SQS_MAX_RECEIVE_COUNT` | `5` | tentativas antes da DLQ |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | visibilidade das mensagens |
| `PENDING_REFERENCE_BASE_DELAY_MS` / `_MAX_DELAY_MS` / `_MAX_ATTEMPTS` | `2000` / `300000` / `10` | backoff de referências ausentes (~17 min no total) |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_POLL_INTERVAL_MS` | `50` / `500` | publisher da outbox |
| `LOG_LEVEL` | `info` | nível dos logs JSON |

## Estrutura

```
src/
  domain/            Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos, settleWager (regras puras)
  application/       casos de uso, portas (repositórios, relógio, ids, métricas, logger), erros, hash canônico
  infrastructure/    MikroORM (EntitySchema, migrations, repositórios), SQS (consumer, filas), workers, observabilidade
  interfaces/http/   controllers NestJS, mapeamento de erros, guard de autenticação (ponto de extensão)
test/
  unit/  integration/  concurrency/  support/harness.ts
scripts/             migrate.ts, load-test.ts
```
