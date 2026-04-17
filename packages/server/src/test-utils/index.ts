/** Test infrastructure — PGlite-based, no external Postgres needed. */

import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Kysely } from "kysely";
import { createCoreApp } from "../app/server.js";
import { seedInitialKek } from "../crypto/key-rotation.js";
import { EnvelopeEncryption } from "../crypto/envelope.js";
import type { CoreApp } from "../app/types.js";
import type { Database } from "../db/database.js";
import type { UserService } from "../services/user.service.js";
import { makeEffectKysely } from "../db/effect-kysely-toolkit.js";

export type { Database } from "../db/database.js";
export type { CoreApp } from "../app/types.js";
export { expectRpcFailure } from "./rpc-error.js";

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
  /**
   * Optional user validator injected into the AppHost. Tests that exercise
   * admission coalescing or validator short-circuiting pass a counting fake;
   * default `undefined` preserves the open-access behavior of the original
   * harness (admit all owners).
   */
  userService?: UserService;
}): Promise<CoreTestServer> {
  if (coreApp)
    throw new Error(
      "Test server already running. Call stopCoreTestServer() first.",
    );

  const { KyselyPGlite } = await import("kysely-pglite");
  const kpg = await KyselyPGlite.create();

  pgliteClient = kpg.client;
  // Use the Effect-patched Kysely builder so service code can `yield*`
  // builder chains directly. The returned instance is still `Kysely<DB>`-
  // compatible for seed helpers that use the promise API.
  appDb = makeEffectKysely<Database>({
    dialect: kpg.dialect,
  });

  const srcPath = join(__dirname, "..", "app", "core-schema.sql");
  const distPath = join(__dirname, "..", "..", "src", "app", "core-schema.sql");
  const schemaPath = existsSync(srcPath) ? srcPath : distPath;
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
    userService: _opts?.userService,
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
      app_permission_grants, app_session_conversations, app_session_participants, app_sessions,
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
