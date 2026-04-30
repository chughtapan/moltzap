/** Test infrastructure — PGlite-based, no external Postgres needed. */

import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Kysely } from "kysely";
import { Effect, pipe, type Layer } from "effect";
import { createCoreApp } from "../app/server.js";
import { seedInitialKek } from "../crypto/key-rotation.js";
import { EnvelopeEncryption } from "../crypto/envelope.js";
import type { CoreApp } from "../app/types.js";
import type { TraceCaptureTag } from "../runtime-surface/trace-capture.js";
import type { Database } from "../db/database.js";
import type { UserService } from "../services/user.service.js";
import { makeEffectKysely } from "../db/effect-kysely-toolkit.js";

export type { Database } from "../db/database.js";
export type { CoreApp } from "../app/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal duplicate of `@moltzap/runtimes`'s `awaitAgentReadyByPolling` and
// `RuntimeServerHandle`/`ReadyOutcome` shapes. We can't import from
// `@moltzap/runtimes` here without flipping the workspace dep direction
// (runtimes already devDeps server-core); structural typing keeps both
// sides honest — the integration test threads `runtimeServer` directly into
// the adapter's `RuntimeServerHandle` slot, so any drift surfaces at compile
// time on the consumer.
type CoreTestReadyOutcome =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Timeout"; readonly timeoutMs: number }
  | {
      readonly _tag: "ProcessExited";
      readonly exitCode: number | null;
      readonly stderr: string;
    };

export interface CoreTestRuntimeServerHandle {
  awaitAgentReady(
    agentId: string,
    timeoutMs: number,
  ): Effect.Effect<CoreTestReadyOutcome, never, never>;
}

function awaitAgentReadyByPolling(
  connections: {
    getByAgent(id: string): ReadonlyArray<{ readonly auth: unknown | null }>;
  },
  agentId: string,
  timeoutMs: number,
): Effect.Effect<CoreTestReadyOutcome, never, never> {
  const tick = Effect.sync(() => {
    const conns = connections.getByAgent(agentId);
    return conns.length > 0 && conns[0]!.auth !== null;
  });
  const pollLoop = pipe(
    tick,
    Effect.flatMap((ready) =>
      Effect.iterate(ready, {
        while: (s) => !s,
        body: () => Effect.sleep("500 millis").pipe(Effect.zipRight(tick)),
      }),
    ),
    Effect.as<CoreTestReadyOutcome>({ _tag: "Ready" as const }),
  );
  return pipe(
    pollLoop,
    Effect.timeoutTo({
      duration: `${timeoutMs} millis`,
      onSuccess: (outcome): CoreTestReadyOutcome => outcome,
      onTimeout: (): CoreTestReadyOutcome => ({
        _tag: "Timeout" as const,
        timeoutMs,
      }),
    }),
  );
}

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
  /**
   * Pre-wired `RuntimeServerHandle` for runtime-adapter tests. Implements
   * `awaitAgentReady` by polling the live `ConnectionManager` — the same
   * pattern `@moltzap/runtimes`'s `awaitAgentReadyByPolling` exports for
   * downstream in-process consumers. Out-of-process consumers (zapbot's
   * orchestrator) construct their own handle over WebSocket presence.
   */
  runtimeServer: CoreTestRuntimeServerHandle;
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
  traceCaptureLayer?: Layer.Layer<TraceCaptureTag>;
}): Promise<CoreTestServer> {
  if (coreApp)
    throw new Error(
      "Test server already running. Call stopCoreTestServer() first.",
    );

  const { KyselyPGlite } = await import("kysely-pglite");
  const kpg = await KyselyPGlite.create();

  pgliteClient = kpg.client;
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
    traceCaptureLayer: _opts?.traceCaptureLayer,
  });

  await new Promise((r) => setTimeout(r, 200));

  const assignedPort = coreApp.port;
  _baseUrl = `http://localhost:${assignedPort}`;
  _wsUrl = `ws://localhost:${assignedPort}/ws`;

  const runtimeServer: CoreTestRuntimeServerHandle = {
    awaitAgentReady: (agentId, timeoutMs) =>
      awaitAgentReadyByPolling(coreApp!.connections, agentId, timeoutMs),
  };

  return {
    baseUrl: _baseUrl,
    wsUrl: _wsUrl,
    db: appDb,
    coreApp,
    runtimeServer,
  };
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
