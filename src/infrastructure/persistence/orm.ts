import { MikroORM, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { AppConfig } from '../config/app-config';
import { Migration20261120000001_initial_schema } from './migrations/Migration20261120000001_initial_schema';
import { ENTITY_SCHEMAS } from './schemas/records';

/** Migrations are listed explicitly: no filesystem discovery at runtime. */
export const MIGRATIONS = [
  { name: 'Migration20261120000001_initial_schema', class: Migration20261120000001_initial_schema },
];

export function ormOptions(config: AppConfig): Options {
  return {
    clientUrl: config.database.url,
    entities: ENTITY_SCHEMAS,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    pool: {
      min: config.database.poolMin,
      max: config.database.poolMax,
      // Applied once per physical connection: a transaction never waits for a
      // row lock longer than lock_timeout (→ transient error, retried later).
      afterCreate: (conn: { query: (sql: string, cb: (err?: Error) => void) => void }, done: (err: Error | undefined, conn: unknown) => void) => {
        conn.query(
          `SET lock_timeout = ${Number(config.database.lockTimeoutMs)}; SET statement_timeout = ${Number(config.database.statementTimeoutMs)}; SET idle_in_transaction_session_timeout = 60000`,
          (err) => done(err, conn),
        );
      },
    },
    // Decimal columns stay strings; timestamps come back as Date.
    forceUtcTimezone: true,
    // Identity map is never relied upon: each use case runs in its own fork.
    allowGlobalContext: false,
    debug: false,
  };
}

export async function createOrm(config: AppConfig): Promise<MikroORM> {
  return MikroORM.init(ormOptions(config));
}
