/** Standalone server — loads YAML config, boots PGlite or Postgres, starts the server. */

import { randomUUID } from "node:crypto";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./db/sql.js";
import { Data, Effect, Either } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { validateAppManifest, type AppManifest } from "@moltzap/protocol";
import type { MoltZapAppConfig as MoltZapConfig } from "./config/effect-config.js";
import { createCoreApp } from "./app/server.js";
import { seedInitialKek } from "./crypto/key-rotation.js";
import { EnvelopeEncryption } from "./crypto/envelope.js";
import { makeEffectKysely } from "./db/effect-kysely-toolkit.js";
import { WebhookClient } from "./adapters/webhook.js";
import { WebhookContactService } from "./adapters/webhook-contact-service.js";
import { WebhookSessionValidator } from "./identity/services/session-validator.js";
import type { CoreApp, CoreConfig } from "./app/types.js";
import type { Database } from "./db/database.js";
import type { Db } from "./db/client.js";
import { PostgresDialect } from "./db/postgres-dialect.js";
import {
  runtimeConfigPath,
  loadRuntimeProcessConfig,
  type RuntimeConfigSurfaceError,
} from "./runtime-surface/config.js";
import { currentArgv, isStandaloneDirectRun } from "./runtime/direct-run.js";

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

/**
 * Decode failure for an on-disk app manifest. `kind` discriminates JSON
 * parse failures from schema-validation failures so callers can log the
 * specific edge that fired without re-inspecting the cause.
 */
export class InvalidAppManifest extends Data.TaggedError("InvalidAppManifest")<{
  readonly kind: "parse" | "schema";
  readonly path: string;
  readonly errors: readonly string[];
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

// ── App-manifest boundary validation ───────────────────────────────
//
// Principle 2: data crossing a boundary (JSON file on disk) is decoded
// against the protocol manifest validator before it reaches
// `app.registerApp(...)`.
// Without this, a malformed-but-JSON-parseable manifest (missing
// `appId`, wrong `participantFilter`, retired hook key, etc.) would
// flow as `any` into `AppHost` and only surface deep inside RPC
// handlers.

/**
 * Parses and validates a JSON manifest blob. Returns `Right(AppManifest)`
 * on success, `Left(InvalidAppManifest)` on either JSON-parse failure
 * (`kind: "parse"`) or schema-validation failure (`kind: "schema"`).
 * Never throws. Exported for test access only.
 */
function parseAppManifestJson(
  json: string,
  path: string,
): Effect.Effect<unknown, InvalidAppManifest> {
  return Effect.try({
    try: () => JSON.parse(json) as unknown,
    catch: (cause) =>
      new InvalidAppManifest({
        kind: "parse",
        path,
        errors: [cause instanceof Error ? cause.message : String(cause)],
      }),
  });
}

function validateParsedAppManifest(
  parsed: unknown,
  path: string,
): Effect.Effect<AppManifest, InvalidAppManifest> {
  return Either.match(validateAppManifest(parsed), {
    onLeft: (error) =>
      Effect.fail(
        new InvalidAppManifest({
          kind: "schema",
          path,
          errors: error.errors,
        }),
      ),
    onRight: Effect.succeed,
  });
}

function decodeAppManifestEffect(
  json: string,
  path: string,
): Effect.Effect<AppManifest, InvalidAppManifest> {
  return Effect.gen(function* () {
    const parsed = yield* parseAppManifestJson(json, path);
    return yield* validateParsedAppManifest(parsed, path);
  });
}

export function decodeAppManifest(
  json: string,
  path: string,
): Either.Either<AppManifest, InvalidAppManifest> {
  return Effect.runSync(Effect.either(decodeAppManifestEffect(json, path)));
}

// ── Database factory ────────────────────────────────────────────────

interface DbHandle {
  db: Db;
  cleanup: () => Effect.Effect<void, StandaloneOperationFailed, never>;
  runMigrationSql: (
    sql: string,
  ) => Effect.Effect<void, StandaloneOperationFailed, never>;
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
      cleanup: () =>
        // Close the PGlite client after Kysely releases its connection. We use
        // an Effect chain here rather than raw Promise composition to keep the
        // sequencing guard-friendly.
        Effect.tryPromise({
          try: () => db.destroy(),
          catch: (cause) => operationFailed("destroy pglite kysely", cause),
        }).pipe(
          Effect.flatMap(() =>
            Effect.tryPromise({
              try: () => kpg.client.close(),
              catch: (cause) => operationFailed("close pglite client", cause),
            }),
          ),
        ),
      runMigrationSql: (sqlText: string) =>
        Effect.tryPromise({
          try: () => kpg.client.exec(sqlText),
          catch: (cause) => operationFailed("run pglite migration sql", cause),
        }).pipe(Effect.asVoid),
    };
  });
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

function startServerEffect(
  configPath?: string,
): Effect.Effect<StandaloneServerHandle, StandaloneServerError, never> {
  return Effect.gen(function* () {
    const runtimeConfig = yield* loadRuntimeProcessConfig(
      configPath === undefined
        ? {}
        : { configPath: runtimeConfigPath(configPath) },
    );
    // Create database (PGlite if no URL, Postgres otherwise)
    const appConfig = runtimeConfig.app;
    const databaseUrl = runtimeConfig.server.database.url;
    const usePgLite = databaseUrl.length === 0;
    const handle = yield* usePgLite
      ? createPgLiteDb(appConfig.database?.data_dir)
      : createPostgresDb(databaseUrl);

    if (usePgLite) {
      yield* Effect.logInfo(
        "Using embedded PGlite database (no external Postgres needed)",
      );
    }

    // Auto-migrate
    yield* autoMigrateEffect(
      handle,
      runtimeConfig.server.encryption.masterSecret,
    ).pipe(Effect.provide(NodeFileSystem.layer));

    const webhookClient = new WebhookClient();

    const sessionValidatorCfg = appConfig.services?.sessions;
    const sessionValidator =
      sessionValidatorCfg?.type === "webhook" && sessionValidatorCfg.webhook_url
        ? new WebhookSessionValidator(
            webhookClient,
            sessionValidatorCfg.webhook_url,
            sessionValidatorCfg.timeout_ms ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
          )
        : undefined;

    // Dev mode: when `dev_mode.enabled` in YAML, agents registered via the
    // default HTTP register route are auto-owned by this UUID — the
    // "developer at the keyboard". Skips the external-claim handshake so
    // the quickstart can reach the app-session flow without Supabase etc.
    // Production MUST leave `dev_mode.enabled` false (or absent).
    const devModeUserId = appConfig.dev_mode?.enabled
      ? (appConfig.dev_mode.user_id ?? randomUUID())
      : undefined;
    if (devModeUserId) {
      yield* Effect.logWarning(
        "dev_mode.enabled=true - registered agents will be auto-owned; do not use in production",
      ).pipe(Effect.annotateLogs({ devModeUserId }));
    }

    const coreConfig: CoreConfig = {
      db: handle.db,
      dbCleanup: () => Effect.runPromise(handle.cleanup()),
      encryptionMasterSecret: runtimeConfig.server.encryption.masterSecret,
      port: runtimeConfig.server.server.port,
      corsOrigins: runtimeConfig.server.server.corsOrigins.exact,
      registrationSecret: appConfig.registration?.secret,
      devMode: runtimeConfig.server.devMode,
      devModeUserId,
      sessionValidator,
      webhookClient,
    };

    const app = createCoreApp(coreConfig);

    if (
      appConfig.services?.contacts?.type === "webhook" &&
      appConfig.services.contacts.webhook_url
    ) {
      app.setContactService(
        new WebhookContactService(
          webhookClient,
          appConfig.services.contacts.webhook_url,
          appConfig.services.contacts.timeout_ms ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
        ),
      );
    }

    // Register app manifests (resolve paths relative to config file location)
    if (appConfig.apps) {
      const configDir = runtimeConfig.configDirectory;
      const fsReadAppManifest = (manifestPath: string) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs
            .readFileString(manifestPath, "utf-8")
            .pipe(
              Effect.mapError((cause) =>
                operationFailed("read app manifest", cause),
              ),
            );
        }).pipe(Effect.provide(NodeFileSystem.layer));

      for (const appRef of appConfig.apps) {
        const manifestPath = isAbsolute(appRef.manifest)
          ? appRef.manifest
          : resolve(configDir, appRef.manifest);
        yield* fsReadAppManifest(manifestPath).pipe(
          Effect.either,
          Effect.flatMap(
            Either.match({
              onLeft: (err) =>
                Effect.logError("Failed to load app manifest").pipe(
                  Effect.annotateLogs({ err, path: appRef.manifest }),
                ),
              onRight: (json) =>
                Either.match(decodeAppManifest(json, appRef.manifest), {
                  onLeft: (err) =>
                    Effect.logError(
                      err.kind === "parse"
                        ? "App manifest JSON parse failed; skipping registration"
                        : "App manifest failed schema validation; skipping registration",
                    ).pipe(
                      Effect.annotateLogs({
                        path: err.path,
                        kind: err.kind,
                        errors: err.errors,
                      }),
                    ),
                  onRight: (manifest) =>
                    Effect.sync(() => {
                      app.registerApp(manifest);
                    }).pipe(
                      Effect.zipRight(
                        Effect.logInfo("App manifest registered").pipe(
                          Effect.annotateLogs({
                            appId: manifest.appId,
                            path: appRef.manifest,
                          }),
                        ),
                      ),
                    ),
                }),
            }),
          ),
        );
      }
    }

    yield* Effect.logInfo("MoltZap server started (standalone mode)").pipe(
      Effect.annotateLogs({
        port: app.port,
        mode: "standalone",
        db: usePgLite ? "pglite" : "postgres",
      }),
    );

    return {
      app,
      config: appConfig,
      // `app.close()` already returns `Promise<void>` — forward it directly.
      stop: () => app.close(),
    };
  });
}

// Auto-start when run directly (e.g. `node dist/standalone.js`, `tsx src/standalone.ts`)
// bin/moltzap-server calls startServer() explicitly via import.
if (isStandaloneDirectRun(currentArgv())) {
  startServer().catch((err) => {
    Effect.runFork(
      Effect.logError("Server startup failed").pipe(
        Effect.annotateLogs({ err }),
      ),
    );
    process.exit(1);
  });
}
