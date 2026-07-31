/** Test infrastructure — PGlite-based, no external Postgres needed. */

import { randomBytes } from "node:crypto";
import { Effect, pipe, Schema } from "effect";
import {
  type RegistrationSecret,
  registrationSecret,
  type ServerEncryptionMasterSecret,
  serverEncryptionMasterSecret,
} from "#config/secrets";
import {
  type UserId,
  userId,
  type AgentId,
  type UserId as UserIdValue,
} from "@moltzap/protocol/identity";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createCoreApp, type CoreApp } from "#core";
import { EnvelopeEncryption, seedInitialKek } from "#db/crypto";
import { makeEffectKysely, type Database, type EffectKysely } from "#db";
import { loadCoreSchemaSql } from "./core-schema-sql.js";
import type {
  CoreTestDatabasePort,
  CoreTestReadyOutcome,
  CoreTestRuntimeServerHandle,
  CoreTestServerPort,
  CoreTestSpanExporterPort,
} from "./ports.js";

/** Re-exports the public API from `#db`. */
export type { Database } from "#db";
/** Re-exports the public API from `#core`. */
export type { CoreApp } from "#core";

class CoreTestServerError extends Error {
  override readonly name = "CoreTestServerError";

  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

const ENCRYPTION_MASTER_SECRET_BYTES = 32;
const PGLITE_BOOT_DELAY_MS = 200;
/** Validates and decodes default test admin user id values. */
export const DEFAULT_TEST_ADMIN_USER_ID: UserIdValue = Schema.decodeUnknownSync(
  userId,
)("00000000-0000-4000-8000-00000000ad00");

// Server integration fixtures keep their readiness polling local so the
// production server package does not depend on the higher-level simulator.
function awaitAgentReadyByPolling(
  connections: {
    agentConnections(id: AgentId): Effect.Effect<readonly unknown[]>;
  },
  agentId: AgentId,
  timeoutMs: number,
): Effect.Effect<CoreTestReadyOutcome> {
  // Agent connections are returned only after authentication, so a non-empty
  // result is sufficient readiness for test servers.
  const tick = connections
    .agentConnections(agentId)
    .pipe(Effect.map((conns) => conns.length > 0));
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
/* eslint-disable @typescript-eslint/no-invalid-void-type -- PGlite's third-party close contract returns Promise<void>. */
let pgliteClient: {
  exec: (sql: string) => PromiseLike<unknown>;
  close: () => PromiseLike<void>;
} | null = null;
/* eslint-enable @typescript-eslint/no-invalid-void-type -- Restore strict defaults after the scoped exception. -- Restore strict defaults after the scoped exception. -- Restore strict defaults after the scoped exception. */
let masterSecretValue: ServerEncryptionMasterSecret | null = null;
let baseUrlValue: string | null = null;
let wsUrlValue: string | null = null;
let spanExporter: InMemorySpanExporter | null = null;

/** Describes core test server handle. */
export interface CoreTestServerHandle {
  baseUrl: string;
  wsUrl: string;
  db: EffectKysely<Database>;
  coreApp: CoreApp;

  /**
   * Pre-wired server handle that reports readiness from the live
   * `ConnectionManager`. Out-of-process consumers construct their own handle
   * over the WebSocket connection they already hold.
   */
  runtimeServer: CoreTestRuntimeServerHandle;

  /**
   * The auto-wired `InMemorySpanExporter`, or `null` when the caller
   * supplied a custom `spanProcessor`. Tests that want to inspect OTel
   * spans call `getFinishedSpans()` on this exporter and map them via
   * their own package-specific projection.
   */
  readonly spanExporter: InMemorySpanExporter | null;

  /** Published projection that keeps persistence and tracing vendors private. */
  readonly testPort: CoreTestServerPort;
}

interface StartCoreTestServerOptions {
  pgHost?: string;
  pgPort?: number;
  encryption?: boolean;

  /**
   * When set, registration routes require `inviteCode` to match this value.
   * When `undefined`, the invite gate is disabled and agent/app registration is
   * open.
   */
  registrationSecret?: string | RegistrationSecret;
  adminUserId?: UserId;
  spanProcessor?: SpanProcessor;
}

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

function seedEncryptionKey(
  db: EffectKysely<Database>,
  masterSecret: ServerEncryptionMasterSecret,
) {
  const envelope = new EnvelopeEncryption(masterSecret);
  return Effect.tryPromise({
    try: () => seedInitialKek(db, envelope),
    catch: (cause) =>
      new CoreTestServerError("Initial encryption key seed failed", cause),
  });
}

function destroyDb() {
  const db = appDb;
  return db === undefined || db === null
    ? Promise.resolve(undefined)
    : Effect.runPromise(
        Effect.tryPromise({
          try: () => db.destroy(),
          catch: (cause) =>
            new CoreTestServerError("Database destroy failed", cause),
        }).pipe(Effect.as(undefined)),
      );
}

function ensureNoCoreTestServerRunning() {
  if (!coreApp) {
    return Effect.void;
  }
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
  if (!opts.encryption) {
    return Effect.succeed(undefined);
  }
  const masterSecret = randomBytes(ENCRYPTION_MASTER_SECRET_BYTES).toString(
    "base64",
  );
  const decoded = Schema.decodeUnknownSync(serverEncryptionMasterSecret)(
    masterSecret,
  );
  masterSecretValue = decoded;
  return seedEncryptionKey(db, decoded).pipe(Effect.as(decoded));
}

function resolveTestSpanProcessor(
  opts: StartCoreTestServerOptions,
): SpanProcessor | undefined {
  if (opts.spanProcessor !== undefined) {
    return opts.spanProcessor;
  }
  spanExporter = new InMemorySpanExporter();
  return new SimpleSpanProcessor(spanExporter);
}

function decodeRegistrationSecret(
  secret: StartCoreTestServerOptions["registrationSecret"],
): RegistrationSecret | undefined {
  if (secret === undefined) {
    return undefined;
  }
  if (typeof secret !== "string") {
    return secret;
  }
  return Schema.decodeUnknownSync(registrationSecret)(secret);
}

function createCoreTestApp(
  db: EffectKysely<Database>,
  opts: StartCoreTestServerOptions,
  masterSecret?: ServerEncryptionMasterSecret,
): CoreApp {
  return createCoreApp({
    db,
    dbCleanup: destroyDb,
    encryptionMasterSecret: masterSecret,
    port: 0,
    corsOrigins: ["*"],
    devMode: true,
    adminUserId: opts.adminUserId ?? DEFAULT_TEST_ADMIN_USER_ID,
    registrationSecret: decodeRegistrationSecret(opts.registrationSecret),
    spanProcessor: resolveTestSpanProcessor(opts),
  });
}

function publishCoreTestUrls(app: CoreApp): { baseUrl: string; wsUrl: string } {
  const assignedPort = app.port;
  baseUrlValue = `http://localhost:${assignedPort}`;
  wsUrlValue = `ws://localhost:${assignedPort}/ws`;
  return { baseUrl: baseUrlValue, wsUrl: wsUrlValue };
}

function makeRuntimeServer(app: CoreApp): CoreTestRuntimeServerHandle {
  return {
    awaitAgentReady: (agentId, timeoutMs) =>
      awaitAgentReadyByPolling(app.connections, agentId, timeoutMs),
  };
}

function makeDatabasePort(): CoreTestDatabasePort {
  return {
    execute: (sql) => Effect.runPromise(execPglite(sql)),
    reset: resetCoreTestDb,
  };
}

function makeSpanExporterPort(
  exporter: InMemorySpanExporter | null,
): CoreTestSpanExporterPort | null {
  if (exporter === null) {
    return null;
  }
  return {
    getFinishedSpans: () =>
      exporter.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: { ...span.attributes },
      })),
    reset: () => {
      exporter.reset();
    },
  };
}

function buildCoreTestServer(
  app: CoreApp,
  db: EffectKysely<Database>,
): CoreTestServerHandle {
  const urls = publishCoreTestUrls(app);
  const runtimeServer = makeRuntimeServer(app);
  const testPort: CoreTestServerPort = {
    ...urls,
    db: makeDatabasePort(),
    runtimeServer,
    spanExporter: makeSpanExporterPort(spanExporter),
  };
  return {
    ...urls,
    db,
    coreApp: app,
    runtimeServer,
    spanExporter,
    testPort,
  };
}

/**
 * Executes the start core test server effect operation.
 * @param opts Value supplied to the operation.
 * @returns The start core test server effect result.
 */
export function startCoreTestServerEffect(
  opts: StartCoreTestServerOptions = {},
) {
  return Effect.gen(function* () {
    yield* ensureNoCoreTestServerRunning();
    const db = yield* initializeTestDatabase();
    const masterSecret = yield* configureEncryption(db, opts);
    coreApp = createCoreTestApp(db, opts, masterSecret);
    yield* Effect.sleep(`${PGLITE_BOOT_DELAY_MS} millis`);
    return buildCoreTestServer(coreApp, db);
  }).pipe(Effect.withSpan("startCoreTestServer"));
}

/**
 * Executes the start core test server full operation.
 * @param opts Value supplied to the operation.
 * @returns The start core test server full result.
 */
export function startCoreTestServerFull(opts: StartCoreTestServerOptions = {}) {
  return Effect.runPromise(startCoreTestServerEffect(opts));
}

/**
 * Executes the stop core test server operation.
 * @returns The stop core test server result.
 */
export function stopCoreTestServer() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const app = coreApp;
      const client = pgliteClient;

      coreApp = null;
      appDb = null;
      pgliteClient = null;
      masterSecretValue = null;
      baseUrlValue = null;
      wsUrlValue = null;
      spanExporter = null;

      yield* Effect.tryPromise({
        try: () => app?.close() ?? Promise.resolve(undefined),
        catch: (cause) =>
          new CoreTestServerError("Core test app close failed", cause),
      });
      if (client) {
        yield* closePglite(client).pipe(Effect.catchAll(() => Effect.void));
      }
    }).pipe(Effect.withSpan("stopCoreTestServer")),
  );
}

/**
 * Executes the reset core test db operation.
 * @returns The reset core test db result.
 */
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
      agents, encryption_keys
    CASCADE;
  `);
      if (masterSecretValue && appDb) {
        yield* seedEncryptionKey(appDb, masterSecretValue);
      }
    }).pipe(Effect.withSpan("resetCoreTestDb")),
  );
}

/**
 * Returns core db.
 * @returns The get core db result.
 */
export function getCoreDb(): EffectKysely<Database> {
  if (!appDb) {
    throw new CoreTestServerError(
      "Test server not running. Call startCoreTestServer() first.",
    );
  }
  return appDb;
}

/**
 * Returns core encryption envelope.
 * @returns The get core encryption envelope result.
 */
export function getCoreEncryptionEnvelope(): EnvelopeEncryption {
  if (!masterSecretValue) {
    throw new CoreTestServerError("Test server encryption not enabled.");
  }
  return new EnvelopeEncryption(masterSecretValue);
}

/**
 * Returns base url.
 * @returns The get base url result.
 */
export function getBaseUrl(): string {
  if (!baseUrlValue) {
    throw new CoreTestServerError("Test server not running.");
  }
  return baseUrlValue;
}

/**
 * Returns ws url.
 * @returns The get ws url result.
 */
export function getWsUrl(): string {
  if (!wsUrlValue) {
    throw new CoreTestServerError("Test server not running.");
  }
  return wsUrlValue;
}
