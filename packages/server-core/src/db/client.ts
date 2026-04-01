import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./database.js";
import { logger } from "../logger.js";

export function createDb(connectionString: string): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
  });

  pool.on("error", (err) => {
    logger.error({ err }, "Unexpected database pool error");
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

export type Db = Kysely<Database>;
