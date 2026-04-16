/** Dev server entry point — `pnpm dev` runs this via tsx. */

import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { loadCoreConfig } from "./config.js";
import { createCoreApp } from "./server.js";
import type { Database } from "../db/database.js";

const config = loadCoreConfig();

const pool = new pg.Pool({
  connectionString: config.database.url,
  max: 20,
  idleTimeoutMillis: 30000,
});
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

createCoreApp({
  db,
  dbCleanup: async () => {
    await db.destroy();
  },
  encryptionMasterSecret: config.encryption.masterSecret,
  port: config.server.port,
  corsOrigins: config.server.corsOrigins.exact,
  devMode: config.devMode,
});
