import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Every invariant the challenge lists in §6 is enforced by
 * PostgreSQL itself (constraints, partial unique indexes and triggers), not
 * only by application code.
 */
export class Migration20261120000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      create table wallets (
        id              uuid primary key,
        player_id       uuid not null,
        currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance_amount  numeric(18,2) not null check (balance_amount >= 0),
        version         integer not null check (version >= 1),
        created_at      timestamptz not null,
        updated_at      timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency),
        -- lets the ledger reference (wallet, currency) so a ledger line can
        -- never be in another currency than its wallet
        constraint wallets_id_currency_uq unique (id, currency)
      );
    `);

    // ---------------------------------------------------- wager transactions
    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        text not null check (length(provider_id) between 1 and 128),
        external_transaction_id            text not null check (length(external_transaction_id) between 1 and 128),
        idempotency_key                    text not null check (length(idempotency_key) between 1 and 256),
        payload_hash                       char(64) not null,
        wallet_id                          uuid not null references wallets(id),
        player_id                          uuid not null,
        round_id                           text not null,
        game_id                            text not null,
        kind                               text not null
          check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                             numeric(18,2) not null check (amount >= 0),
        currency                           char(3) not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id  text,
        reference_transaction_id           uuid references wager_transactions(id),
        status                             text not null
          check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                       text,
        observed_balance_amount            numeric(18,2) check (observed_balance_amount >= 0),
        attempts                           integer not null default 0 check (attempts >= 0),
        next_attempt_at                    timestamptz,
        created_at                         timestamptz not null,
        processed_at                       timestamptz,
        updated_at                         timestamptz not null,

        constraint wager_tx_idempotency_key_uq unique (idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_tx_reference_required_ck
          check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_amount_positive_ck
          check (kind = 'LOSS' or amount > 0),
        constraint wager_tx_failure_code_ck
          check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wager_tx_terminal_has_processed_at_ck
          check ((status in ('PROCESSED','REJECTED','FAILED')) = (processed_at is not null)),
        constraint wager_tx_pending_has_schedule_ck
          check (status <> 'PENDING_REFERENCE' or next_attempt_at is not null)
      );
    `);
    // A reference can be reversed (REFUND or ROLLBACK) at most once.
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';
    `);
    // At most one OPENING per wallet.
    this.addSql(`
      create unique index wager_tx_single_opening_uq
        on wager_transactions (wallet_id) where kind = 'OPENING';
    `);
    this.addSql(`
      create index wager_tx_pending_reference_due_idx
        on wager_transactions (next_attempt_at) where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      create index wager_tx_waiting_reference_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wager_tx_wallet_idx on wager_transactions (wallet_id, created_at);`);
    // Business fields of a transaction are immutable once written.
    this.addSql(`
      create function wager_tx_guard_immutable() returns trigger language plpgsql as $$
      begin
        if new.id <> old.id
           or new.provider_id <> old.provider_id
           or new.external_transaction_id <> old.external_transaction_id
           or new.idempotency_key <> old.idempotency_key
           or new.payload_hash <> old.payload_hash
           or new.wallet_id <> old.wallet_id
           or new.player_id <> old.player_id
           or new.round_id <> old.round_id
           or new.game_id <> old.game_id
           or new.kind <> old.kind
           or new.amount <> old.amount
           or new.currency <> old.currency
           or new.reference_external_transaction_id is distinct from old.reference_external_transaction_id
           or new.created_at <> old.created_at then
          raise exception 'wager transaction % business fields are immutable', old.id
            using errcode = 'check_violation';
        end if;
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'wager transaction % is in terminal status %', old.id, old.status
            using errcode = 'check_violation';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger wager_tx_guard_immutable before update on wager_transactions
        for each row execute function wager_tx_guard_immutable();
    `);
    this.addSql(`
      create function forbid_delete() returns trigger language plpgsql as $$
      begin
        raise exception 'rows of % are append-only', tg_table_name using errcode = 'check_violation';
      end $$;
    `);
    this.addSql(`
      create trigger wager_tx_no_delete before delete on wager_transactions
        for each row execute function forbid_delete();
    `);

    // ---------------------------------------------------------------- ledger
    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        wallet_id       uuid not null,
        transaction_id  uuid not null references wager_transactions(id),
        direction       text not null check (direction in ('DEBIT','CREDIT')),
        amount          numeric(18,2) not null check (amount > 0),
        currency        char(3) not null,
        balance_before  numeric(18,2) not null check (balance_before >= 0),
        balance_after   numeric(18,2) not null check (balance_after >= 0),
        wallet_version  integer not null check (wallet_version >= 1),
        created_at      timestamptz not null,
        constraint ledger_wallet_currency_fk foreign key (wallet_id, currency)
          references wallets (id, currency),
        -- one financial transaction → at most one entry per wallet
        constraint ledger_wallet_transaction_uq unique (wallet_id, transaction_id),
        -- gap-free version chain per wallet (also the stable pagination key)
        constraint ledger_wallet_version_uq unique (wallet_id, wallet_version),
        constraint ledger_balanced_ck check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );
    `);
    // Append-only: no UPDATE, DELETE or TRUNCATE.
    this.addSql(`
      create function ledger_forbid_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% forbidden)', tg_op
          using errcode = 'check_violation';
      end $$;
    `);
    this.addSql(`
      create trigger ledger_no_update_delete before update or delete on wallet_ledger_entries
        for each row execute function ledger_forbid_mutation();
    `);
    this.addSql(`
      create trigger ledger_no_truncate before truncate on wallet_ledger_entries
        for each statement execute function ledger_forbid_mutation();
    `);
    // Each new entry must continue the chain of the previous one.
    this.addSql(`
      create function ledger_check_chain() returns trigger language plpgsql as $$
      declare
        prev_after numeric(18,2);
        has_prior  boolean;
      begin
        select balance_after into prev_after
          from wallet_ledger_entries
         where wallet_id = new.wallet_id and wallet_version = new.wallet_version - 1;
        if not found then
          select exists(select 1 from wallet_ledger_entries where wallet_id = new.wallet_id)
            into has_prior;
          if has_prior then
            raise exception 'ledger chain broken for wallet %: version % has no predecessor',
              new.wallet_id, new.wallet_version using errcode = 'check_violation';
          end if;
          prev_after := 0;
        end if;
        if new.balance_before <> prev_after then
          raise exception 'ledger chain broken for wallet %: balance_before % <> previous balance_after %',
            new.wallet_id, new.balance_before, prev_after using errcode = 'check_violation';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger ledger_check_chain before insert on wallet_ledger_entries
        for each row execute function ledger_check_chain();
    `);

    // ------------------------------------------- wallet ↔ ledger consistency
    // version changes exactly when the balance changes, by exactly +1.
    this.addSql(`
      create function wallet_guard_version() returns trigger language plpgsql as $$
      begin
        if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency
           or new.created_at <> old.created_at then
          raise exception 'wallet % identity is immutable', old.id using errcode = 'check_violation';
        end if;
        if new.balance_amount <> old.balance_amount and new.version <> old.version + 1 then
          raise exception 'wallet % balance changed without version +1', old.id using errcode = 'check_violation';
        end if;
        if new.balance_amount = old.balance_amount and new.version <> old.version then
          raise exception 'wallet % version changed without balance change', old.id using errcode = 'check_violation';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger wallet_guard_version before update on wallets
        for each row execute function wallet_guard_version();
    `);
    this.addSql(`create trigger wallet_no_delete before delete on wallets for each row execute function forbid_delete();`);
    // Deferred to commit time: the wallet state must be explained by the
    // ledger entry carrying its current version (or be an empty opening).
    this.addSql(`
      create function wallet_check_ledger() returns trigger language plpgsql as $$
      declare
        entry_after numeric(18,2);
      begin
        select balance_after into entry_after
          from wallet_ledger_entries
         where wallet_id = new.id and wallet_version = new.version;
        if not found then
          if new.version = 1 and new.balance_amount = 0 then
            return null;
          end if;
          raise exception 'wallet % version % has no matching ledger entry', new.id, new.version
            using errcode = 'check_violation';
        end if;
        if entry_after <> new.balance_amount then
          raise exception 'wallet % balance % differs from ledger balance_after %',
            new.id, new.balance_amount, entry_after using errcode = 'check_violation';
        end if;
        return null;
      end $$;
    `);
    this.addSql(`
      create constraint trigger wallet_check_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallet_check_ledger();
    `);

    // ----------------------------------------------------------------- inbox
    this.addSql(`
      create table inbox_messages (
        consumer_name  text not null,
        message_id     text not null,
        payload_hash   char(64) not null,
        received_at    timestamptz not null,
        processed_at   timestamptz,
        primary key (consumer_name, message_id)
      );
    `);

    // ---------------------------------------------------------------- outbox
    this.addSql(`
      create table outbox_messages (
        id               uuid primary key,
        aggregate_id     uuid not null,
        event_type       text not null,
        payload          jsonb not null,
        occurred_at      timestamptz not null,
        attempts         integer not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        last_error       text
      );
    `);
    this.addSql(`
      create index outbox_pending_idx on outbox_messages (next_attempt_at, occurred_at)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop trigger if exists ledger_no_truncate on wallet_ledger_entries;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop table if exists wallets;');
    this.addSql('drop function if exists wallet_check_ledger();');
    this.addSql('drop function if exists wallet_guard_version();');
    this.addSql('drop function if exists ledger_check_chain();');
    this.addSql('drop function if exists ledger_forbid_mutation();');
    this.addSql('drop function if exists forbid_delete();');
    this.addSql('drop function if exists wager_tx_guard_immutable();');
  }
}
