/** Standalone server — loads YAML config, boots PGlite, and starts the server. */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { createCoreApp, type CoreApp } from "#core";
import {
  loadStandaloneConfig,
  type CoreConfig,
  type ConfigLoadError,
  type StandaloneBootPlan,
} from "#config";
import { sql, makeEffectKysely, type Database, type Db } from "#db";

const dirnameValue = dirname(fileURLToPath(import.meta.url));

/** Implements standalone operation failed. */
export class StandaloneOperationFailed extends Data.TaggedError(
  "StandaloneOperationFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
  readonly operation: string;
}> {}

/** Implements schema file not found. */
export class SchemaFileNotFound extends Data.TaggedError("SchemaFileNotFound")<{
  readonly message: string;
}> {}

type StandaloneServerError =
  | ConfigLoadError
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
  runMigrationSql: (
    sql: string,
  ) => Effect.Effect<void, StandaloneOperationFailed>;
}

interface PgLiteClientHandle {
  readonly exec: (sql: string) => PromiseLike<unknown>;
}

function createPgLiteDb(
  dataDir?: string,
): Effect.Effect<DbHandle, StandaloneOperationFailed> {
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
      runMigrationSql: (sqlText: string) =>
        runPgLiteMigrationSql(kpg.client, sqlText),
    };
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

// ── Migration ───────────────────────────────────────────────────────

function findSchemaFile(): Effect.Effect<string, SchemaFileNotFound> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = (candidate: string) =>
      fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));

    // Dev (tsx): running from src/, schema in src/db/
    const devPath = join(dirnameValue, "db", "core-schema.sql");
    if (yield* exists(devPath)) {
      return devPath;
    }
    // Compiled (node dist/): schema in ../src/db/
    const distPath = join(dirnameValue, "..", "src", "db", "core-schema.sql");
    if (yield* exists(distPath)) {
      return distPath;
    }
    return yield* new SchemaFileNotFound({
      message:
        "Cannot find core-schema.sql. Ensure it exists at the package root or in src/db/.",
    });
  }).pipe(Effect.provide(NodeFileSystem.layer));
}

/**
 * Run the schema migration. Effect-native: reads the schema file via the
 * platform `FileSystem` service and bridges to `handle.runMigrationSql` at the
 * Kysely boundary (which still exposes a Promise API for raw DDL).
 * @param handle Value supplied to the operation.
 * @returns The auto migrate effect result.
 */
/**
 * A database whose `agents` table exists but whose `messages` table lacks
 * the plaintext `parts` column predates the current schema generation (or
 * was partially migrated by hand). Booting against it would pass the
 * has-schema gate and then fail on every send at runtime, so the mismatch
 * is a boot error, not a skip: there is no in-place migration path —
 * recreate the database from the current schema. The check asserts the
 * REQUIRED current shape in the connection's own schema rather than probing
 * for retired artifacts, so unrelated tables in other schemas cannot
 * trip it.
 * @param handle Value supplied to the operation.
 * @returns Failure when the schema predates the current generation.
 */
function rejectRetiredSchema(
  handle: DbHandle,
): Effect.Effect<void, StandaloneOperationFailed> {
  return Effect.gen(function* () {
    const shape = yield* Effect.tryPromise({
      try: () =>
        sql<{ has_current_shape: boolean }>`
          SELECT EXISTS (
            SELECT FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'messages'
              AND column_name = 'parts'
          ) AS has_current_shape
        `.execute(handle.db),
      catch: (cause) => operationFailed("check schema generation", cause),
    });
    if (shape.rows[0]?.has_current_shape !== true) {
      return yield* Effect.fail(
        operationFailed(
          "verify schema generation",
          new Error(
            "database schema predates the app-principal/lease removal (messages.parts is missing) and has no in-place migration; recreate the database from db/core-schema.sql",
          ),
        ),
      );
    }
  });
}

function autoMigrateEffect(
  handle: DbHandle,
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
      yield* rejectRetiredSchema(handle);
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

    yield* Effect.logInfo("Database schema applied successfully");
  });
}

// ── Main ────────────────────────────────────────────────────────────

/**
 * Executes the start server operation.
 * @param configPath Value supplied to the operation.
 * @returns The start server result.
 */
export function startServer(configPath?: string) {
  if (configPath === undefined) {
    return Effect.runPromise(startServerEffect());
  }
  return Effect.runPromise(startServerEffect(configPath));
}

interface StandaloneServerHandle {
  readonly app: CoreApp;
  readonly bootPlan: StandaloneBootPlan;
}

function startServerEffect(
  configPath?: string,
): Effect.Effect<StandaloneServerHandle, StandaloneServerError> {
  return Effect.gen(function* () {
    const bootPlan = yield* loadStandaloneConfig({ configPath });
    const database = yield* createPgLiteDb(bootPlan.pgliteDataDir);
    yield* migrateStandaloneDatabase(database);
    yield* Effect.logWarning("Boot admin user configured").pipe(
      Effect.annotateLogs({ adminUserId: bootPlan.adminUserId }),
    );
    const coreConfig = makeCoreConfig({
      bootPlan,
      handle: database,
    });
    const app = createCoreApp(coreConfig);
    yield* logStandaloneStarted(app);
    return { app, bootPlan };
  }).pipe(Effect.withSpan("startServerEffect"));
}

function migrateStandaloneDatabase(handle: DbHandle) {
  return autoMigrateEffect(handle).pipe(Effect.provide(NodeFileSystem.layer));
}

function makeCoreConfig(options: {
  readonly bootPlan: StandaloneBootPlan;
  readonly handle: DbHandle;
}): CoreConfig {
  const { bootPlan, handle } = options;
  return {
    db: handle.db,
    port: bootPlan.port,
    corsOrigins: bootPlan.corsOrigins,
    registrationSecret: bootPlan.registrationSecret,
    adminUserId: bootPlan.adminUserId,
  };
}

function logStandaloneStarted(app: CoreApp): Effect.Effect<void> {
  return Effect.logInfo("MoltZap server started (standalone mode)").pipe(
    Effect.annotateLogs({
      port: app.port,
      mode: "standalone",
      db: "pglite",
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
  startServer().catch((err: unknown) => {
    Effect.runFork(
      Effect.logError("Server startup failed").pipe(
        Effect.annotateLogs({ err }),
      ),
    );
    process.exit(1);
  });
}
