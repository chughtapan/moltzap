/** Test infrastructure — PGlite-based, no external Postgres needed. */

import { randomBytes } from "node:crypto";
import { Effect, pipe } from "effect";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createCoreApp } from "../app/server.js";
import { seedInitialKek } from "../crypto/key-rotation.js";
import { EnvelopeEncryption } from "../crypto/envelope.js";
import type { CoreApp } from "../app/types.js";
import type { Database } from "../db/database.js";
import type { SessionValidator } from "../identity/services/session-validator.js";
import {
  makeEffectKysely,
  type EffectKysely,
} from "../db/effect-kysely-toolkit.js";
import { loadCoreSchemaSql } from "./core-schema-sql.js";

export type { Database } from "../db/database.js";
export type { CoreApp } from "../app/types.js";

class CoreTestServerError extends Error {
  override readonly name = "CoreTestServerError";

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

const ENCRYPTION_MASTER_SECRET_BYTES = 32;
const PGLITE_BOOT_DELAY_MS = 200;

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
let appDb: EffectKysely<Database> | null = null;
let pgliteClient: {
  exec: (sql: string) => PromiseLike<unknown>;
  close: () => PromiseLike<void>;
} | null = null;
let _masterSecret: string | null = null;
let _baseUrl: string | null = null;
let _wsUrl: string | null = null;
let spanExporter: InMemorySpanExporter | null = null;

export interface CoreTestServer {
  baseUrl: string;
  wsUrl: string;
  db: EffectKysely<Database>;
  coreApp: CoreApp;

  /**
   * Pre-wired `RuntimeServerHandle` for runtime-adapter tests. Implements
   * `awaitAgentReady` by polling the live `ConnectionManager` — the same
   * pattern `@moltzap/runtimes`'s `awaitAgentReadyByPolling` exports for
   * downstream in-process consumers. Out-of-process consumers (zapbot's
   * orchestrator) construct their own handle over WebSocket presence.
   */
  runtimeServer: CoreTestRuntimeServerHandle;

  /**
   * The auto-wired `InMemorySpanExporter`, or `null` when the caller
   * supplied a custom `spanProcessor`. Tests that want to inspect OTel
   * spans call `getFinishedSpans()` on this exporter and map them via
   * their own shim (see `runtimes/` for arena's mapping).
   */
  readonly spanExporter: InMemorySpanExporter | null;
}

type StartCoreTestServerOptions = {
  pgHost?: string;
  pgPort?: number;
  encryption?: boolean;

  /**
   * Optional user validator injected into the AppHost. Tests that exercise
   * admission coalescing or validator short-circuiting pass a counting fake;
   * default `undefined` preserves the open-access behavior of the original
   * harness (admit all owners).
   */
  sessionValidator?: SessionValidator;

  /**
   * When set, the server requires `inviteCode` matching this value on
   * `/api/v1/auth/register` and enables the `/api/v1/admin/register-agent`
   * route. Default `undefined` keeps the open-registration behavior the
   * existing tests depend on.
   */
  registrationSecret?: string;
  devModeUserId?: string;
  spanProcessor?: SpanProcessor;
};

function importPglite() {
  return Effect.tryPromise({
    try: () => import("kysely-pglite"),
    catch: (cause) => new CoreTestServerError("PGlite import failed", cause),
  });
}

function execPglite(sql: string) {
  const client = pgliteClient;
  if (!client) {
    return Effect.fail(
      new CoreTestServerError("PGlite client not initialized."),
    );
  }
  return Effect.tryPromise({
    try: () => client.exec(sql),
    catch: (cause) => new CoreTestServerError("PGlite exec failed", cause),
  });
}

function closePglite(client: NonNullable<typeof pgliteClient>) {
  return Effect.tryPromise({
    try: () => client.close(),
    catch: (cause) => new CoreTestServerError("PGlite close failed", cause),
  });
}

function seedEncryptionKey(db: EffectKysely<Database>, masterSecret: string) {
  const envelope = new EnvelopeEncryption(masterSecret);
  return Effect.tryPromise({
    try: () => seedInitialKek(db, envelope),
    catch: (cause) =>
      new CoreTestServerError("Initial encryption key seed failed", cause),
  });
}

function destroyDb() {
  const db = appDb;
  return db?.destroy() ?? Promise.resolve();
}

function ensureNoCoreTestServerRunning() {
  if (!coreApp) return Effect.void;
  return Effect.fail(
    new CoreTestServerError(
      "Test server already running. Call stopCoreTestServer() first.",
    ),
  );
}

function createPgliteInstance() {
  return Effect.gen(function* () {
    const { KyselyPGlite } = yield* importPglite();
    return yield* Effect.tryPromise({
      try: () => KyselyPGlite.create(),
      catch: (cause) =>
        new CoreTestServerError("PGlite instance creation failed", cause),
    });
  });
}

function initializeTestDatabase() {
  return Effect.gen(function* () {
    const kpg = yield* createPgliteInstance();
    pgliteClient = kpg.client;
    appDb = makeEffectKysely<Database>({ dialect: kpg.dialect });
    const schema = yield* loadCoreSchemaSql();
    yield* execPglite(schema);
    return appDb;
  });
}

function configureEncryption(
  db: EffectKysely<Database>,
  opts: StartCoreTestServerOptions,
) {
  if (!opts.encryption) return Effect.succeed(undefined);
  const masterSecret = randomBytes(ENCRYPTION_MASTER_SECRET_BYTES).toString(
    "base64",
  );
  _masterSecret = masterSecret;
  return seedEncryptionKey(db, masterSecret).pipe(Effect.as(masterSecret));
}

function resolveTestSpanProcessor(
  opts: StartCoreTestServerOptions,
): SpanProcessor | undefined {
  if (opts.spanProcessor !== undefined) return opts.spanProcessor;
  spanExporter = new InMemorySpanExporter();
  return new SimpleSpanProcessor(spanExporter);
}

function createCoreTestApp(
  db: EffectKysely<Database>,
  opts: StartCoreTestServerOptions,
  masterSecret: string | undefined,
): CoreApp {
  return createCoreApp({
    db,
    dbCleanup: destroyDb,
    encryptionMasterSecret: masterSecret,
    port: 0,
    corsOrigins: ["*"],
    devMode: true,
    devModeUserId: opts.devModeUserId,
    sessionValidator: opts.sessionValidator,
    registrationSecret: opts.registrationSecret,
    spanProcessor: resolveTestSpanProcessor(opts),
  });
}

function publishCoreTestUrls(app: CoreApp): { baseUrl: string; wsUrl: string } {
  const assignedPort = app.port;
  _baseUrl = `http://localhost:${assignedPort}`;
  _wsUrl = `ws://localhost:${assignedPort}/ws`;
  return { baseUrl: _baseUrl, wsUrl: _wsUrl };
}

function makeRuntimeServer(app: CoreApp): CoreTestRuntimeServerHandle {
  return {
    awaitAgentReady: (agentId, timeoutMs) =>
      awaitAgentReadyByPolling(app.connections, agentId, timeoutMs),
  };
}

function buildCoreTestServer(
  app: CoreApp,
  db: EffectKysely<Database>,
): CoreTestServer {
  const urls = publishCoreTestUrls(app);
  return {
    ...urls,
    db,
    coreApp: app,
    runtimeServer: makeRuntimeServer(app),
    spanExporter,
  };
}

export function startCoreTestServer(opts: StartCoreTestServerOptions = {}) {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* ensureNoCoreTestServerRunning();
      const db = yield* initializeTestDatabase();
      const masterSecret = yield* configureEncryption(db, opts);
      coreApp = createCoreTestApp(db, opts, masterSecret);
      yield* Effect.sleep(`${PGLITE_BOOT_DELAY_MS} millis`);
      return buildCoreTestServer(coreApp, db);
    }).pipe(Effect.withSpan("startCoreTestServer")),
  );
}

export function stopCoreTestServer() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const app = coreApp;
      const client = pgliteClient;

      coreApp = null;
      appDb = null;
      pgliteClient = null;
      _masterSecret = null;
      _baseUrl = null;
      _wsUrl = null;
      spanExporter = null;

      yield* Effect.tryPromise({
        try: () => app?.close() ?? Promise.resolve(),
        catch: (cause) =>
          new CoreTestServerError("Core test app close failed", cause),
      });
      if (client) {
        yield* closePglite(client).pipe(Effect.catchAll(() => Effect.void));
      }
    }).pipe(Effect.withSpan("stopCoreTestServer")),
  );
}

export function resetCoreTestDb() {
  return Effect.runPromise(
    Effect.gen(function* () {
      if (!pgliteClient || !appDb) {
        return yield* Effect.fail(
          new CoreTestServerError(
            "Test server not running. Call startCoreTestServer() first.",
          ),
        );
      }
      yield* execPglite(`
    TRUNCATE TABLE
      task_participants, tasks,
      messages,
      conversation_participants, conversation_keys, conversations,
      contacts,
      agents, encryption_keys
    CASCADE;
  `);
      if (_masterSecret && appDb) {
        yield* seedEncryptionKey(appDb, _masterSecret);
      }
    }).pipe(Effect.withSpan("resetCoreTestDb")),
  );
}

export function getCoreDb(): EffectKysely<Database> {
  if (!appDb)
    throw new CoreTestServerError(
      "Test server not running. Call startCoreTestServer() first.",
    );
  return appDb;
}

export function getCoreEncryptionEnvelope(): EnvelopeEncryption {
  if (!_masterSecret) {
    throw new CoreTestServerError("Test server encryption not enabled.");
  }
  return new EnvelopeEncryption(_masterSecret);
}

export function getCoreApp(): CoreApp {
  if (!coreApp)
    throw new CoreTestServerError(
      "Test server not running. Call startCoreTestServer() first.",
    );
  return coreApp;
}

export function getBaseUrl(): string {
  if (!_baseUrl) throw new CoreTestServerError("Test server not running.");
  return _baseUrl;
}

export function getWsUrl(): string {
  if (!_wsUrl) throw new CoreTestServerError("Test server not running.");
  return _wsUrl;
}
