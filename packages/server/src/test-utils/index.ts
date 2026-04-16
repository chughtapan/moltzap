/** Test infrastructure — PGlite-based, no external Postgres needed. */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Kysely } from "kysely";
import { createCoreApp } from "../app/server.js";
import { seedInitialKek } from "../crypto/key-rotation.js";
import { EnvelopeEncryption } from "../crypto/envelope.js";
import type { CoreApp } from "../app/types.js";
import type { Database } from "../db/database.js";

export type { Database } from "../db/database.js";
export type { CoreApp } from "../app/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let coreApp: CoreApp | null = null;
let appDb: Kysely<Database> | null = null;
let pgliteClient: {
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
} | null = null;
let _masterSecret: string | null = null;
let _baseUrl: string | null = null;
let _wsUrl: string | null = null;

export interface CoreTestServer {
  baseUrl: string;
  wsUrl: string;
  db: Kysely<Database>;
  coreApp: CoreApp;
}

export async function startCoreTestServer(_opts?: {
  pgHost?: string;
  pgPort?: number;
  encryption?: boolean;
}): Promise<CoreTestServer> {
  if (coreApp)
    throw new Error(
      "Test server already running. Call stopCoreTestServer() first.",
    );

  const { KyselyPGlite } = await import("kysely-pglite");
  const kpg = await KyselyPGlite.create();

  pgliteClient = kpg.client as unknown as {
    exec: (sql: string) => Promise<unknown>;
    close: () => Promise<void>;
  };
  appDb = new Kysely<Database>({ dialect: kpg.dialect });

  // Apply core schema — __dirname is src/test-utils, schema is at src/app/core-schema.sql
  const schemaPath = join(__dirname, "..", "app", "core-schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  await pgliteClient.exec(schema);

  let masterSecret: string | undefined;
  if (_opts?.encryption) {
    masterSecret = randomBytes(32).toString("base64");
    _masterSecret = masterSecret;
    const envelope = new EnvelopeEncryption(masterSecret);
    await seedInitialKek(appDb, envelope);
  }

  coreApp = createCoreApp({
    db: appDb,
    dbCleanup: async () => {
      await appDb?.destroy();
    },
    encryptionMasterSecret: masterSecret,
    port: 0,
    corsOrigins: ["*"],
    devMode: true,
  });

  await new Promise((r) => setTimeout(r, 200));

  const assignedPort = coreApp.port;
  _baseUrl = `http://localhost:${assignedPort}`;
  _wsUrl = `ws://localhost:${assignedPort}/ws`;

  return { baseUrl: _baseUrl, wsUrl: _wsUrl, db: appDb, coreApp };
}

export async function stopCoreTestServer(): Promise<void> {
  const app = coreApp;
  const client = pgliteClient;

  coreApp = null;
  appDb = null;
  pgliteClient = null;
  _masterSecret = null;
  _baseUrl = null;
  _wsUrl = null;

  await app?.close();
  // app.close() calls dbCleanup which destroys Kysely (and PGlite underneath).
  // Guard against double-close.
  try {
    await client?.close();
  } catch {
    // PGlite already closed by dbCleanup
  }
}

export async function resetCoreTestDb(): Promise<void> {
  if (!pgliteClient || !appDb) {
    throw new Error(
      "Test server not running. Call startCoreTestServer() first.",
    );
  }
  await pgliteClient.exec(`
    TRUNCATE TABLE
      app_permission_grants, app_session_participants, app_sessions,
      message_delivery, messages,
      conversation_participants, conversation_keys, conversations,
      agents, encryption_keys
    CASCADE;
  `);
  if (_masterSecret && appDb) {
    const envelope = new EnvelopeEncryption(_masterSecret);
    await seedInitialKek(appDb, envelope);
  }
}

export function getCoreDb(): Kysely<Database> {
  if (!appDb)
    throw new Error(
      "Test server not running. Call startCoreTestServer() first.",
    );
  return appDb;
}

export function getCoreApp(): CoreApp {
  if (!coreApp)
    throw new Error(
      "Test server not running. Call startCoreTestServer() first.",
    );
  return coreApp;
}

export function getBaseUrl(): string {
  if (!_baseUrl) throw new Error("Test server not running.");
  return _baseUrl;
}

export function getWsUrl(): string {
  if (!_wsUrl) throw new Error("Test server not running.");
  return _wsUrl;
}
