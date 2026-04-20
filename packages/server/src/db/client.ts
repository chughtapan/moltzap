import { type Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./database.js";
import { makeEffectKysely } from "./effect-kysely-toolkit.js";
import { logger } from "../logger.js";

/**
 * Build a patched Kysely instance backed by a Postgres connection string.
 *
 * The returned instance is Effect-patched: builder chains can be used
 * directly as `Effect`s (`yield* db.selectFrom(...).where(...)`), while
 * promise-style APIs (`db.insertInto(...).execute()`, `db.transaction()`)
 * still work for code that hasn't been migrated yet.
 */
export function createDb(connectionString: string): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
  });

  pool.on("error", (err) => {
    logger.error({ err }, "Unexpected database pool error");
  });

  return makeEffectKysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

/**
 * The canonical DB type.
 *
 * Under the hood this is always an `EffectKysely<Database>` — the Effect
 * patches add builder-as-Effect support on top of Kysely's existing
 * Promise API, so code that depends on `Kysely<Database>` shape continues
 * to work without modification.
 */
export type Db = Kysely<Database>;
