import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect } from "kysely";
import { createCoreApp } from "../../examples/server.js";
import { seedInitialKek } from "../crypto/key-rotation.js";
import { EnvelopeEncryption } from "../crypto/envelope.js";
import type { CoreApp } from "../../examples/types.js";
import type { Database } from "../db/database.js";

export type { Database } from "../db/database.js";
export type { CoreApp } from "../../examples/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let coreApp: CoreApp | null = null;
let adminPool: pg.Pool | null = null;
let resetPool: pg.Pool | null = null;
let resetDb: Kysely<Database> | null = null;
let dbName: string | null = null;
let masterSecret: string | null = null;
let _baseUrl: string | null = null;
let _wsUrl: string | null = null;
let pgContainer: unknown = null;

export interface CoreTestServer {
  baseUrl: string;
  wsUrl: string;
  db: Kysely<Database>;
  coreApp: CoreApp;
}

/**
 * Start a core test server with its own Postgres.
 *
 * If pgHost/pgPort are provided, uses that Postgres (e.g., from vitest globalSetup).
 * If omitted, starts a testcontainers Postgres automatically.
 */
export async function startCoreTestServer(opts?: {
  pgHost?: string;
  pgPort?: number;
}): Promise<CoreTestServer> {
  if (coreApp)
    throw new Error(
      "Test server already running. Call stopCoreTestServer() first.",
    );

  let pgHost = opts?.pgHost;
  let pgPort = opts?.pgPort;

  if (!pgHost || !pgPort) {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("moltzap_template")
      .withUsername("test")
      .withPassword("test")
      .start();
    pgContainer = container;
    pgHost = container.getHost();
    pgPort = container.getMappedPort(5432);

    // Apply core schema to the template DB
    const schemaPath = join(
      __dirname,
      "..",
      "..",
      "examples",
      "core-schema.sql",
    );
    const schema = readFileSync(schemaPath, "utf-8");
    const setupPool = new pg.Pool({
      host: pgHost,
      port: pgPort,
      user: "test",
      password: "test",
      database: "moltzap_template",
      max: 2,
    });
    await setupPool.query(schema);
    await setupPool.end();
  }

  dbName = `test_${crypto.randomUUID().replace(/-/g, "")}`;
  masterSecret = randomBytes(32).toString("base64");

  adminPool = new pg.Pool({
    host: pgHost,
    port: pgPort,
    user: "test",
    password: "test",
    database: "postgres",
    max: 2,
  });
  await adminPool.query(
    `CREATE DATABASE "${dbName}" TEMPLATE moltzap_template`,
  );

  const connString = `postgresql://test:test@${pgHost}:${pgPort}/${dbName}`;

  resetPool = new pg.Pool({ connectionString: connString, max: 2 });
  resetDb = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: resetPool }),
  });

  const envelope = new EnvelopeEncryption(masterSecret);
  await seedInitialKek(resetDb, envelope);

  coreApp = createCoreApp({
    databaseUrl: connString,
    encryptionMasterSecret: masterSecret,
    port: 0,
    corsOrigins: ["*"],
    devMode: true,
  });

  await new Promise((r) => setTimeout(r, 200));

  const assignedPort = coreApp.port;
  _baseUrl = `http://localhost:${assignedPort}`;
  _wsUrl = `ws://localhost:${assignedPort}/ws`;

  return { baseUrl: _baseUrl, wsUrl: _wsUrl, db: resetDb, coreApp };
}

export async function stopCoreTestServer(): Promise<void> {
  const app = coreApp;
  const db = resetDb;
  const admin = adminPool;
  const reset = resetPool;
  const name = dbName;
  const container = pgContainer;

  // Null out singletons FIRST to prevent double-end on sequential test files
  coreApp = null;
  adminPool = null;
  resetPool = null;
  resetDb = null;
  dbName = null;
  masterSecret = null;
  _baseUrl = null;
  _wsUrl = null;
  pgContainer = null;

  await app?.close();
  // Kysely.destroy() ends the underlying pool — don't also call resetPool.end()
  await db?.destroy();
  if (admin && name) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    } catch {
      // Ignore — DB may already be gone
    }
    await admin.end();
  }

  if (
    container &&
    typeof (container as { stop: () => Promise<void> }).stop === "function"
  ) {
    await (container as { stop: () => Promise<void> }).stop();
  }
}

export async function resetCoreTestDb(): Promise<void> {
  if (!resetPool || !resetDb || !masterSecret) {
    throw new Error(
      "Test server not running. Call startCoreTestServer() first.",
    );
  }
  await resetPool.query(`
    TRUNCATE TABLE
      reactions, message_delivery, messages,
      conversation_participants, conversation_keys, conversations,
      agents, users, encryption_keys
    CASCADE;
  `);
  const envelope = new EnvelopeEncryption(masterSecret);
  await seedInitialKek(resetDb, envelope);
}

export function getCoreDb(): Kysely<Database> {
  if (!resetDb)
    throw new Error(
      "Test server not running. Call startCoreTestServer() first.",
    );
  return resetDb;
}

export function getBaseUrl(): string {
  if (!_baseUrl) throw new Error("Test server not running.");
  return _baseUrl;
}

export function getWsUrl(): string {
  if (!_wsUrl) throw new Error("Test server not running.");
  return _wsUrl;
}
