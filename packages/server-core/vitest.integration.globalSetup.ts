import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalSetupContext } from "vitest/node";

let container: StartedPostgreSqlContainer | null = null;

export default async function ({ provide }: GlobalSetupContext) {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("moltzap_template")
    .withUsername("test")
    .withPassword("test")
    .start();

  // Apply core-schema.sql (single source of truth for core tables)
  const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  const schemaPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "examples",
    "core-schema.sql",
  );
  const sql = readFileSync(schemaPath, "utf-8");
  await pool.query(sql);
  await pool.end();

  provide("testPgHost", container.getHost());
  provide("testPgPort", container.getMappedPort(5432));

  return async () => {
    await container?.stop();
    container = null;
  };
}
