/** Standalone server — loads YAML config, boots PGlite or Postgres, starts the server. */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Data, Effect, Either } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import type { MoltZapAppConfig as MoltZapConfig } from "./config/effect-config.js";
import { createCoreApp } from "./app/server.js";
import { seedInitialKek } from "./crypto/key-rotation.js";
import { EnvelopeEncryption } from "./crypto/envelope.js";
import { makeEffectKysely } from "./db/effect-kysely-toolkit.js";
import { WebhookClient, WebhookContactService } from "./adapters/webhook.js";
import { WebhookUserService } from "./services/user.service.js";
import { logger } from "./logger.js";
import type { CoreApp, CoreConfig } from "./app/types.js";
import type { Database } from "./db/database.js";
import {
  RuntimeConfigPath,
  loadRuntimeProcessConfig,
  type RuntimeConfigSurfaceError,
} from "./runtime-surface/config.js";
import {
  createRuntimeObservability,
  type RuntimeObservabilityError,
} from "./runtime-surface/logging.js";

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
  | RuntimeObservabilityError
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
  db: Kysely<Database>;
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
  // Docker: copied to package root
  const dockerPath = join(__dirname, "..", "core-schema.sql");
  if (existsSync(dockerPath)) return Effect.succeed(dockerPath);
  // Dev (tsx): running from src/, schema in src/app/
  const devPath = join(__dirname, "app", "core-schema.sql");
  if (existsSync(devPath)) return Effect.succeed(devPath);
  // Compiled (node dist/): schema in ../src/app/
  const distPath = join(__dirname, "..", "src", "app", "core-schema.sql");
  if (existsSync(distPath)) return Effect.succeed(distPath);
  return Effect.fail(
    new SchemaFileNotFound({
      message:
        "Cannot find core-schema.sql. Ensure it exists at the package root or in src/app/.",
    }),
  );
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
      logger.info("Database schema already exists, skipping migration");
      return;
    }

    logger.info("Applying database schema...");

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
      logger.info(
        "Encryption not configured — messages will be stored as plaintext",
      );
    }

    logger.info("Database schema applied successfully");
  });
}

// ── Main ────────────────────────────────────────────────────────────

export function startServer(configPath?: string) {
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
        : { configPath: RuntimeConfigPath(configPath) },
    );
    const observability = yield* createRuntimeObservability(runtimeConfig);
    const log = observability.logger;

    // Create database (PGlite if no URL, Postgres otherwise)
    const appConfig = runtimeConfig.app;
    const databaseUrl = runtimeConfig.server.database.url;
    const usePgLite = databaseUrl.length === 0;
    const handle = yield* usePgLite
      ? createPgLiteDb(appConfig.database?.data_dir)
      : createPostgresDb(databaseUrl);

    if (usePgLite) {
      log.info("Using embedded PGlite database (no external Postgres needed)");
    }

    // Auto-migrate
    yield* autoMigrateEffect(
      handle,
      runtimeConfig.server.encryption.masterSecret,
    ).pipe(Effect.provide(NodeFileSystem.layer));

    // Build CoreConfig
    // Wire webhook services. UserService is part of CoreConfig (injected into
    // AppHost via Layer) because the admission path needs it at construction
    // time; the contacts service can be bound imperatively after
    // createCoreApp since it gates per-request behavior.
    const webhookClient = new WebhookClient();

    const userServiceCfg = appConfig.services?.users;
    const userService =
      userServiceCfg?.type === "webhook" && userServiceCfg.webhook_url
        ? new WebhookUserService(
            webhookClient,
            userServiceCfg.webhook_url,
            userServiceCfg.timeout_ms ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
            log,
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
      log.warn(
        { devModeUserId },
        "dev_mode.enabled=true — registered agents will be auto-owned; do not use in production",
      );
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
      userService,
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
          log,
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
                Effect.sync(() => {
                  log.error(
                    { err, path: appRef.manifest },
                    "Failed to load app manifest",
                  );
                }),
              onRight: (json) =>
                Effect.sync(() => {
                  try {
                    const manifest = JSON.parse(json);
                    app.registerApp(manifest);
                    log.info(
                      { appId: manifest.appId, path: appRef.manifest },
                      "App manifest registered",
                    );
                  } catch (err) {
                    log.error(
                      { err, path: appRef.manifest },
                      "Failed to load app manifest",
                    );
                  }
                }),
            }),
          ),
        );
      }
    }

    log.info(
      {
        port: app.port,
        mode: "standalone",
        db: usePgLite ? "pglite" : "postgres",
      },
      "MoltZap server started (standalone mode)",
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
const isDirectRun =
  process.argv[1]?.endsWith("standalone.js") ||
  process.argv[1]?.endsWith("standalone.ts");
if (isDirectRun) {
  startServer().catch((err) => {
    logger.error({ err }, "Server startup failed");
    process.exit(1);
  });
}
