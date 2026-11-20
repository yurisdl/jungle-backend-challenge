import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ormOptions } from '../../src/infrastructure/persistence/orm';
import { assertGlobalConsistency, BASE_ENV, ensureSchema, sql, testConfig } from '../support/harness';

/** Raw SQL inside one transaction, so we can test deferred constraints too. */
async function inTx(statements: Array<[string, unknown[]?]>): Promise<void> {
  const { db } = await import('../support/harness');
  const orm = await db();
  await orm.em.fork({ useContext: false }).transactional(async (em) => {
    for (const [q, p] of statements) await em.execute(q, (p ?? []) as any[]);
  });
}

async function seedWallet(balance = '100.00') {
  const walletId = randomUUID();
  const playerId = randomUUID();
  const txId = randomUUID();
  await inTx([
    [
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values (?, ?, 'BRL', ?, 1, now(), now())`,
      [walletId, playerId, balance],
    ],
    [
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, observed_balance_amount,
         created_at, processed_at, updated_at)
       values (?, 'internal', ?, ?, repeat('a', 64), ?, ?, 'opening', 'internal', 'OPENING', ?, 'BRL', 'PROCESSED', ?, now(), now(), now())`,
      [txId, `opening:${walletId}`, `internal:opening:${walletId}`, walletId, playerId, balance, balance],
    ],
    [
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
         balance_before, balance_after, wallet_version, created_at)
       values (?, ?, ?, 'CREDIT', ?, 'BRL', 0, ?, 1, now())`,
      [randomUUID(), walletId, txId, balance, balance],
    ],
  ]);
  return { walletId, playerId, txId };
}

function insertTx(walletId: string, playerId: string, over: Record<string, unknown> = {}) {
  const id = randomUUID();
  const ext = `ext-${id}`;
  const v = {
    id,
    provider_id: 'provider-a',
    external_transaction_id: ext,
    idempotency_key: `provider-a:${ext}`,
    kind: 'BET',
    amount: '10.00',
    status: 'PROCESSED',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    failure_code: null,
    processed_at: new Date(),
    ...over,
  };
  return [
    `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, status, failure_code,
       reference_external_transaction_id, reference_transaction_id, created_at, processed_at, updated_at)
     values (?, ?, ?, ?, repeat('b', 64), ?, ?, 'r', 'g', ?, ?, 'BRL', ?, ?, ?, ?, now(), ?, now())`,
    [
      v.id,
      v.provider_id,
      v.external_transaction_id,
      v.idempotency_key,
      walletId,
      playerId,
      v.kind,
      v.amount,
      v.status,
      v.failure_code,
      v.reference_external_transaction_id,
      v.reference_transaction_id,
      v.processed_at,
    ],
  ] as [string, unknown[]];
}

describe('migrations', () => {
  test('are versioned and reversible (up → down → up on a scratch database)', async () => {
    const scratch = `wagering_migrations_${Date.now()}`;
    await sql(`create database ${scratch}`);
    const url = BASE_ENV.DATABASE_URL!.replace(/\/[^/]+$/, `/${scratch}`);
    const orm = await MikroORM.init(ormOptions(testConfig({ DATABASE_URL: url })));
    try {
      const migrator = orm.getMigrator();
      expect((await migrator.up()).map((m) => m.name)).toEqual(['Migration20261120000001_initial_schema']);
      const tables = async () =>
        (
          await orm.em
            .fork()
            .execute<Array<{ t: string }>>(
              `select table_name as t from information_schema.tables where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by 1`,
            )
        ).map((r) => r.t);
      expect(await tables()).toEqual(['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets']);
      await migrator.down();
      expect(await tables()).toEqual([]);
      await migrator.up();
      expect((await tables()).length).toBe(5);
    } finally {
      await orm.close(true);
      await sql(`drop database ${scratch}`);
    }
  });
});

describe('schema constraints', () => {
  beforeAll(ensureSchema);
  afterAll(assertGlobalConsistency);

  test('one wallet per player + currency', async () => {
    const { playerId } = await seedWallet();
    await expect(
      inTx([
        [
          `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at) values (?, ?, 'BRL', 0, 1, now(), now())`,
          [randomUUID(), playerId],
        ],
      ]),
    ).rejects.toThrow(/wallets_player_currency_uq/);
  });

  test('balance can never be negative', async () => {
    const { walletId } = await seedWallet('5.00');
    await expect(inTx([[`update wallets set balance_amount = -1, version = version + 1 where id = ?`, [walletId]]])).rejects.toThrow(
      /balance_amount|check/,
    );
  });

  test('balance change without matching ledger entry is refused at commit', async () => {
    const { walletId } = await seedWallet('50.00');
    await expect(
      inTx([[`update wallets set balance_amount = 40, version = version + 1 where id = ?`, [walletId]]]),
    ).rejects.toThrow(/no matching ledger entry/);
  });

  test('version must move together with the balance', async () => {
    const { walletId } = await seedWallet('50.00');
    await expect(inTx([[`update wallets set version = version + 1 where id = ?`, [walletId]]])).rejects.toThrow(
      /version changed without balance change/,
    );
    await expect(inTx([[`update wallets set balance_amount = 49, version = version + 2 where id = ?`, [walletId]]])).rejects.toThrow(
      /without version \+1/,
    );
  });

  test('ledger is append-only and arithmetically balanced', async () => {
    const { walletId, playerId } = await seedWallet('50.00');
    await expect(inTx([[`update wallet_ledger_entries set amount = 1 where wallet_id = ?`, [walletId]]])).rejects.toThrow(/append-only/);
    await expect(inTx([[`delete from wallet_ledger_entries where wallet_id = ?`, [walletId]]])).rejects.toThrow(/append-only/);
    await expect(inTx([[`truncate wallet_ledger_entries cascade`]])).rejects.toThrow(/append-only/);

    const bet = insertTx(walletId, playerId);
    await expect(
      inTx([
        bet,
        [
          `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
           values (?, ?, ?, 'DEBIT', 10, 'BRL', 50, 45, 2, now())`,
          [randomUUID(), walletId, bet[1][0]],
        ],
      ]),
    ).rejects.toThrow(/ledger_balanced_ck/);
  });

  test('ledger chain must continue from the previous balance', async () => {
    const { walletId, playerId } = await seedWallet('50.00');
    const bet = insertTx(walletId, playerId);
    await expect(
      inTx([
        bet,
        [
          `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
           values (?, ?, ?, 'DEBIT', 10, 'BRL', 70, 60, 2, now())`,
          [randomUUID(), walletId, bet[1][0]],
        ],
      ]),
    ).rejects.toThrow(/chain broken/);
  });

  test('ledger currency must match the wallet currency', async () => {
    const { walletId, playerId } = await seedWallet('50.00');
    const bet = insertTx(walletId, playerId);
    await expect(
      inTx([
        bet,
        [
          `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
           values (?, ?, ?, 'DEBIT', 10, 'USD', 50, 40, 2, now())`,
          [randomUUID(), walletId, bet[1][0]],
        ],
      ]),
    ).rejects.toThrow(/ledger_wallet_currency_fk/);
  });

  test('one ledger entry per (wallet, transaction)', async () => {
    const { walletId, txId } = await seedWallet('50.00');
    await expect(
      inTx([
        [
          `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
           values (?, ?, ?, 'CREDIT', 1, 'BRL', 50, 51, 2, now())`,
          [randomUUID(), walletId, txId],
        ],
      ]),
    ).rejects.toThrow(/ledger_wallet_transaction_uq/);
  });

  test('idempotency key and (provider, external id) are unique', async () => {
    const { walletId, playerId } = await seedWallet();
    await inTx([insertTx(walletId, playerId, { idempotency_key: 'dup-key-1', external_transaction_id: 'x1' })]);
    await expect(
      inTx([insertTx(walletId, playerId, { idempotency_key: 'dup-key-1', external_transaction_id: 'x2' })]),
    ).rejects.toThrow(/wager_tx_idempotency_key_uq/);
    await expect(
      inTx([insertTx(walletId, playerId, { idempotency_key: 'dup-key-2', external_transaction_id: 'x1' })]),
    ).rejects.toThrow(/wager_tx_provider_external_uq/);
  });

  test('a reference can be reversed only once', async () => {
    const { walletId, playerId } = await seedWallet();
    const bet = insertTx(walletId, playerId);
    const betId = bet[1][0];
    await inTx([bet]);
    await inTx([
      insertTx(walletId, playerId, {
        kind: 'REFUND',
        reference_external_transaction_id: 'ref',
        reference_transaction_id: betId,
      }),
    ]);
    await expect(
      inTx([
        insertTx(walletId, playerId, {
          kind: 'ROLLBACK',
          reference_external_transaction_id: 'ref',
          reference_transaction_id: betId,
        }),
      ]),
    ).rejects.toThrow(/wager_tx_single_reversal_uq/);
  });

  test('REFUND/ROLLBACK need a reference; rejected rows need a failure code', async () => {
    const { walletId, playerId } = await seedWallet();
    await expect(inTx([insertTx(walletId, playerId, { kind: 'REFUND' })])).rejects.toThrow(/wager_tx_reference_required_ck/);
    await expect(inTx([insertTx(walletId, playerId, { status: 'REJECTED' })])).rejects.toThrow(/wager_tx_failure_code_ck/);
  });

  test('terminal transactions and their business fields are immutable; nothing is deleted', async () => {
    const { walletId, playerId } = await seedWallet();
    const bet = insertTx(walletId, playerId);
    await inTx([bet]);
    await expect(
      inTx([[`update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = ?`, [bet[1][0]]]]),
    ).rejects.toThrow(/terminal status/);
    await expect(inTx([[`update wager_transactions set amount = 1 where id = ?`, [bet[1][0]]]])).rejects.toThrow(/immutable/);
    await expect(inTx([[`delete from wager_transactions where id = ?`, [bet[1][0]]]])).rejects.toThrow(/append-only/);
    await expect(inTx([[`delete from wallets where id = ?`, [walletId]]])).rejects.toThrow(/append-only/);
  });
});
