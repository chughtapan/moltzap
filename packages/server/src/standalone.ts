/** Standalone server — loads YAML config, boots PGlite or Postgres, starts the server. */

import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./db/sql.js";
import { Data, Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import type { MoltZapAppConfig as MoltZapConfig } from "./config/effect-config.js";
import { createCoreApp } from "./app/server.js";
import { seedInitialKek } from "./crypto/key-rotation.js";
import { EnvelopeEncryption } from "./crypto/envelope.js";
import { makeEffectKysely } from "./db/effect-kysely-toolkit.js";
import { WebhookClient } from "./adapters/webhook.js";
import { WebhookContactService } from "./adapters/webhook-contact-service.js";
import { WebhookSessionValidator } from "./identity/services/session-validator.js";
import type { CoreApp } from "./app/types.js";
import type { CoreConfig } from "./app/config.js";
import type { Database } from "./db/database.js";
import type { Db } from "./db/client.js";
import { PostgresDialect } from "./db/postgres-dialect.js";
import {
  runtimeConfigPath,
  loadRuntimeProcessConfig,
  type RuntimeProcessConfig,
  type RuntimeConfigSurfaceError,
} from "./runtime-surface/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

export class StandaloneOperationFailed extends Data.TaggedError(
  "StandaloneOperationFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
  readonly operation: string;
}> {}

export class SchemaFileNotFound extends Data.TaggedError("SchemaFileNotFound")<{
  readonly message: string;
}> {}

type StandaloneServerError =
  | RuntimeConfigSurfaceError
  | StandaloneOperationFailed
  | SchemaFileNotFound;

const operationFailed = (
  operation: string,
  cause: unknown,
): StandaloneOperationFailed =>
  new StandaloneOperationFailed({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });

// ── Database factory ────────────────────────────────────────────────

interface DbHandle {
  db: Db;
  cleanup: () => Effect.Effect<void, StandaloneOperationFailed, never>;
  runMigrationSql: (
    sql: string,
  ) => Effect.Effect<void, StandaloneOperationFailed, never>;
}

interface PgLiteClientHandle {
  readonly close: () => PromiseLike<void>;
  readonly exec: (sql: string) => PromiseLike<unknown>;
}

function createPgLiteDb(
  dataDir?: string,
): Effect.Effect<DbHandle, StandaloneOperationFailed, never> {
  return Effect.gen(function* () {
    const { KyselyPGlite } = yield* Effect.tryPromise({
      try: () => import("kysely-pglite"),
      catch: (cause) => operationFailed("load kysely-pglite", cause),
    });

    const kpg = yield* Effect.tryPromise({
      try: () =>
        dataDir ? KyselyPGlite.create(dataDir) : KyselyPGlite.create(),
      catch: (cause) => operationFailed("create pglite database", cause),
    });

    // Effect-patched Kysely: builder chains can be used as `Effect`s inside
    // services while the promise API (`.execute()`, `.transaction()`) still
    // works for migration/seed code.
    const db = makeEffectKysely<Database>({
      dialect: kpg.dialect,
    });

    return {
      db,
      cleanup: () => cleanupPgLiteDb(db, kpg.client),
      runMigrationSql: (sqlText: string) =>
        runPgLiteMigrationSql(kpg.client, sqlText),
    };
  });
}

function cleanupPgLiteDb(
  db: Db,
  client: PgLiteClientHandle,
): Effect.Effect<void, StandaloneOperationFailed> {
  return Effect.tryPromise({
    try: () => db.destroy(),
    catch: (cause) => operationFailed("destroy pglite kysely", cause),
  }).pipe(Effect.flatMap(() => closePgLiteClient(client)));
}

function closePgLiteClient(
  client: PgLiteClientHandle,
): Effect.Effect<void, StandaloneOperationFailed> {
  return Effect.tryPromise({
    try: () => client.close(),
    catch: (cause) => operationFailed("close pglite client", cause),
  });
}

function runPgLiteMigrationSql(
  client: PgLiteClientHandle,
  sqlText: string,
): Effect.Effect<void, StandaloneOperationFailed> {
  return Effect.tryPromise({
    try: () => client.exec(sqlText),
    catch: (cause) => operationFailed("run pglite migration sql", cause),
  }).pipe(Effect.asVoid);
}

function createPostgresDb(
  url: string,
): Effect.Effect<DbHandle, StandaloneOperationFailed, never> {
  return Effect.gen(function* () {
    const pg = yield* Effect.tryPromise({
      try: () => import("pg"),
      catch: (cause) => operationFailed("load pg", cause),
    });
    const pool = new pg.default.Pool({ connectionString: url, max: 20 });
    // Effect-patched Kysely: builder chains can be used as `Effect`s inside
    // services while the promise API (`.execute()`, `.transaction()`) still
    // works for migration/seed code.
    const db = makeEffectKysely<Database>({
      dialect: new PostgresDialect({ pool }),
    });

    return {
      db,
      cleanup: () =>
        Effect.tryPromise({
          try: () => db.destroy(),
          catch: (cause) => operationFailed("destroy postgres kysely", cause),
        }),
      runMigrationSql: (sqlText: string) => {
        // Raw DDL — Kysely can't run before tables exist
        const exec = pool.query.bind(pool);
        return Effect.tryPromise({
          try: () => exec(sqlText),
          catch: (cause) =>
            operationFailed("run postgres migration sql", cause),
        }).pipe(Effect.asVoid);
      },
    };
  });
}

// ── Migration ───────────────────────────────────────────────────────

function findSchemaFile(): Effect.Effect<string, SchemaFileNotFound, never> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = (candidate: string) =>
      fs.exists(candidate).pipe(Effect.catchAll(() => Effect.succeed(false)));

    // Docker: copied to package root
    const dockerPath = join(__dirname, "..", "core-schema.sql");
    if (yield* exists(dockerPath)) return dockerPath;
    // Dev (tsx): running from src/, schema in src/app/
    const devPath = join(__dirname, "app", "core-schema.sql");
    if (yield* exists(devPath)) return devPath;
    // Compiled (node dist/): schema in ../src/app/
    const distPath = join(__dirname, "..", "src", "app", "core-schema.sql");
    if (yield* exists(distPath)) return distPath;
    return yield* Effect.fail(
      new SchemaFileNotFound({
        message:
          "Cannot find core-schema.sql. Ensure it exists at the package root or in src/app/.",
      }),
    );
  }).pipe(Effect.provide(NodeFileSystem.layer));
}

/**
 * Run the schema migration. Effect-native: reads the schema file via the
 * platform `FileSystem` service, seeds the KEK row inside an Effect, and
 * bridges to `handle.runMigrationSql` at the Kysely boundary (which still
 * exposes a Promise API for raw DDL).
 */
function autoMigrateEffect(
  handle: DbHandle,
  encryptionSecret: string | undefined,
): Effect.Effect<
  void,
  SchemaFileNotFound | StandaloneOperationFailed,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        sql<{ has_schema: boolean }>`
          SELECT EXISTS (
            SELECT FROM information_schema.tables WHERE table_name = 'agents'
          ) AS has_schema
        `.execute(handle.db),
      catch: (cause) => operationFailed("check database schema", cause),
    });

    if (result.rows[0]?.has_schema) {
      yield* Effect.logInfo(
        "Database schema already exists, skipping migration",
      );
      return;
    }

    yield* Effect.logInfo("Applying database schema...");

    const fs = yield* FileSystem.FileSystem;
    const schemaPath = yield* findSchemaFile();
    const schema = yield* fs
      .readFileString(schemaPath, "utf-8")
      .pipe(Effect.mapError((cause) => operationFailed("read schema", cause)));

    yield* handle.runMigrationSql(schema);

    if (encryptionSecret) {
      const envelope = new EnvelopeEncryption(encryptionSecret);
      yield* Effect.tryPromise({
        try: () => seedInitialKek(handle.db, envelope),
        catch: (cause) => operationFailed("seed encryption key", cause),
      });
    } else {
      yield* Effect.logInfo(
        "Encryption not configured — messages will be stored as plaintext",
      );
    }

    yield* Effect.logInfo("Database schema applied successfully");
  });
}

// ── Main ────────────────────────────────────────────────────────────

export function startServer(configPath?: string) {
  if (configPath === undefined) {
    return Effect.runPromise(startServerEffect());
  }
  return Effect.runPromise(startServerEffect(configPath));
}

interface StandaloneServerHandle {
  readonly app: CoreApp;
  readonly config: MoltZapConfig;
  readonly stop: CoreApp["close"];
}

interface StandaloneDatabase {
  readonly handle: DbHandle;
  readonly usePgLite: boolean;
}

function startServerEffect(
  configPath?: string,
): Effect.Effect<StandaloneServerHandle, StandaloneServerError, never> {
  return Effect.gen(function* () {
    const runtimeConfig = yield* loadStandaloneRuntimeConfig(configPath);
    const database = yield* createStandaloneDatabase(runtimeConfig);
    yield* logDatabaseSelection(database.usePgLite);
    yield* migrateStandaloneDatabase(database.handle, runtimeConfig);
    const webhookClient = new WebhookClient();
    const sessionValidator = makeSessionValidator(
      runtimeConfig.app,
      webhookClient,
    );
    const devModeUserId = resolveDevModeUserId(runtimeConfig.app);
    yield* warnDevModeUserId(devModeUserId);
    const coreConfig = makeCoreConfig({
      runtimeConfig,
      handle: database.handle,
      devModeUserId,
      sessionValidator,
      webhookClient,
    });
    const app = createCoreApp(coreConfig);
    yield* installContactService(app, runtimeConfig.app, webhookClient);
    yield* logStandaloneStarted(app, database.usePgLite);
    return {
      app,
      config: runtimeConfig.app,
      stop: () => app.close(),
    };
  }).pipe(Effect.withSpan("startServerEffect"));
}

function loadStandaloneRuntimeConfig(
  configPath: string | undefined,
): Effect.Effect<RuntimeProcessConfig, RuntimeConfigSurfaceError> {
  if (configPath === undefined) return loadRuntimeProcessConfig({});
  return loadRuntimeProcessConfig({
    configPath: runtimeConfigPath(configPath),
  });
}

function createStandaloneDatabase(
  runtimeConfig: RuntimeProcessConfig,
): Effect.Effect<StandaloneDatabase, StandaloneOperationFailed> {
  return Effect.gen(function* () {
    const databaseUrl = runtimeConfig.server.database.url;
    if (databaseUrl.length === 0) {
      const handle = yield* createPgLiteDb(
        runtimeConfig.app.database?.data_dir,
      );
      return { handle, usePgLite: true };
    }
    const handle = yield* createPostgresDb(databaseUrl);
    return { handle, usePgLite: false };
  }).pipe(Effect.withSpan("createStandaloneDatabase"));
}

function logDatabaseSelection(usePgLite: boolean): Effect.Effect<void> {
  if (!usePgLite) return Effect.void;
  return Effect.logInfo(
    "Using embedded PGlite database (no external Postgres needed)",
  );
}

function migrateStandaloneDatabase(
  handle: DbHandle,
  runtimeConfig: RuntimeProcessConfig,
) {
  return autoMigrateEffect(
    handle,
    runtimeConfig.server.encryption.masterSecret,
  ).pipe(Effect.provide(NodeFileSystem.layer));
}

function makeSessionValidator(
  appConfig: MoltZapConfig,
  webhookClient: WebhookClient,
): CoreConfig["sessionValidator"] {
  const sessionConfig = appConfig.services?.sessions;
  if (sessionConfig?.type !== "webhook") return undefined;
  const webhookUrl = sessionConfig.webhook_url;
  if (!webhookUrl) return undefined;
  return new WebhookSessionValidator(
    webhookClient,
    webhookUrl,
    sessionConfig.timeout_ms ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
  );
}

function resolveDevModeUserId(appConfig: MoltZapConfig): string | undefined {
  const devMode = appConfig.dev_mode;
  if (devMode?.enabled !== true) return undefined;
  return devMode.user_id ?? randomUUID();
}

function warnDevModeUserId(
  devModeUserId: string | undefined,
): Effect.Effect<void> {
  if (devModeUserId === undefined) return Effect.void;
  return Effect.logWarning(
    "dev_mode.enabled=true - registered agents will be auto-owned; do not use in production",
  ).pipe(Effect.annotateLogs({ devModeUserId }));
}

function makeCoreConfig(options: {
  readonly runtimeConfig: RuntimeProcessConfig;
  readonly handle: DbHandle;
  readonly devModeUserId: string | undefined;
  readonly sessionValidator: CoreConfig["sessionValidator"];
  readonly webhookClient: WebhookClient;
}): CoreConfig {
  const { runtimeConfig, handle } = options;
  return {
    db: handle.db,
    dbCleanup: () => Effect.runPromise(handle.cleanup()),
    encryptionMasterSecret: runtimeConfig.server.encryption.masterSecret,
    port: runtimeConfig.server.server.port,
    corsOrigins: runtimeConfig.server.server.corsOrigins.exact,
    registrationSecret: runtimeConfig.app.registration?.secret,
    devMode: runtimeConfig.server.devMode,
    devModeUserId: options.devModeUserId,
    sessionValidator: options.sessionValidator,
    webhookClient: options.webhookClient,
  };
}

function installContactService(
  app: CoreApp,
  appConfig: MoltZapConfig,
  webhookClient: WebhookClient,
): Effect.Effect<void> {
  return Effect.sync(() => {
    const contacts = appConfig.services?.contacts;
    if (contacts?.type !== "webhook") return;
    const webhookUrl = contacts.webhook_url;
    if (!webhookUrl) return;
    app.setContactService(
      new WebhookContactService(
        webhookClient,
        webhookUrl,
        contacts.timeout_ms ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
      ),
    );
  });
}

function logStandaloneStarted(
  app: CoreApp,
  usePgLite: boolean,
): Effect.Effect<void> {
  return Effect.logInfo("MoltZap server started (standalone mode)").pipe(
    Effect.annotateLogs({
      port: app.port,
      mode: "standalone",
      db: usePgLite ? "pglite" : "postgres",
    }),
  );
}

// Auto-start when run directly (e.g. `node dist/standalone.js`,
// `tsx watch src/standalone.ts`). `bin/moltzap-server` calls
// `startServer()` explicitly via import, so its argv[1] doesn't match
// the standalone suffix and this guard skips.
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- entrypoint-detection: process.argv is the only way to check whether this file was loaded as the direct entry vs. imported by the bin script
const argv1 = process.argv[1];
if (
  argv1?.endsWith("standalone.js") === true ||
  argv1?.endsWith("standalone.ts") === true
) {
  startServer().catch((err) => {
    Effect.runFork(
      Effect.logError("Server startup failed").pipe(
        Effect.annotateLogs({ err }),
      ),
    );
    process.exit(1);
  });
}
