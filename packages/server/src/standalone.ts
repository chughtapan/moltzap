/** Standalone server — loads YAML config, boots PGlite or Postgres, starts the server. */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import type { MoltZapAppConfig as MoltZapConfig } from "./config/effect-config.js";
import { createCoreApp } from "./app/server.js";
import { seedInitialKek } from "./crypto/key-rotation.js";
import { EnvelopeEncryption } from "./crypto/envelope.js";
import { makeEffectKysely } from "./db/effect-kysely-toolkit.js";
import {
  WebhookClient,
  WebhookContactService,
  AsyncWebhookAdapter,
  WebhookPermissionService,
} from "./adapters/webhook.js";
import { WebhookUserService } from "./services/user.service.js";
import { logger } from "./logger.js";
import type { CoreApp, CoreConfig } from "./app/types.js";
import type { Database } from "./db/database.js";
import { loadRuntimeProcessConfig } from "./runtime-surface/config.js";
import type { RuntimeConfigPath } from "./runtime-surface/config.js";
import { createRuntimeObservability } from "./runtime-surface/logging.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// ── Database factory ────────────────────────────────────────────────

interface DbHandle {
  db: Kysely<Database>;
  cleanup: () => Promise<void>;
  runMigrationSql: (sql: string) => Promise<void>;
}

function createPgLiteDb(dataDir?: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { KyselyPGlite } = yield* Effect.tryPromise({
        try: () => import("kysely-pglite"),
        catch: toError,
      });

      const kpg = yield* Effect.tryPromise({
        try: () =>
          dataDir ? KyselyPGlite.create(dataDir) : KyselyPGlite.create(),
        catch: toError,
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
          Effect.runPromise(
            Effect.tryPromise({
              try: () => db.destroy(),
              catch: toError,
            }).pipe(
              Effect.flatMap(() =>
                Effect.tryPromise({
                  try: () => kpg.client.close(),
                  catch: toError,
                }),
              ),
            ),
          ),
        runMigrationSql: (sqlText: string) =>
          Effect.runPromise(
            Effect.tryPromise({
              try: () => kpg.client.exec(sqlText),
              catch: toError,
            }).pipe(Effect.asVoid),
          ),
      };
    }),
  );
}

function createPostgresDb(url: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const pg = yield* Effect.tryPromise({
        try: () => import("pg"),
        catch: toError,
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
        cleanup: () => db.destroy(),
        runMigrationSql: (sqlText: string) => {
          // Raw DDL — Kysely can't run before tables exist
          const exec = pool.query.bind(pool);
          return Effect.runPromise(
            Effect.tryPromise({
              try: () => exec(sqlText),
              catch: toError,
            }).pipe(Effect.asVoid),
          );
        },
      };
    }),
  );
}

// ── Migration ───────────────────────────────────────────────────────

function findSchemaFile(): string {
  // Docker: copied to package root
  const dockerPath = join(__dirname, "..", "core-schema.sql");
  if (existsSync(dockerPath)) return dockerPath;
  // Dev (tsx): running from src/, schema in src/app/
  const devPath = join(__dirname, "app", "core-schema.sql");
  if (existsSync(devPath)) return devPath;
  // Compiled (node dist/): schema in ../src/app/
  const distPath = join(__dirname, "..", "src", "app", "core-schema.sql");
  if (existsSync(distPath)) return distPath;
  throw new Error(
    "Cannot find core-schema.sql. Ensure it exists at the package root or in src/app/.",
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
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        sql<{ has_schema: boolean }>`
          SELECT EXISTS (
            SELECT FROM information_schema.tables WHERE table_name = 'agents'
          ) AS has_schema
        `.execute(handle.db),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

    if (result.rows[0]?.has_schema) {
      logger.info("Database schema already exists, skipping migration");
      return;
    }

    logger.info("Applying database schema...");

    const fs = yield* FileSystem.FileSystem;
    const schema = yield* fs
      .readFileString(findSchemaFile(), "utf-8")
      .pipe(Effect.mapError((e) => new Error(e.message)));

    yield* Effect.tryPromise({
      try: () => handle.runMigrationSql(schema),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

    if (encryptionSecret) {
      const envelope = new EnvelopeEncryption(encryptionSecret);
      yield* Effect.tryPromise({
        try: () => seedInitialKek(handle.db, envelope),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
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

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: Node process entrypoint for standalone server
export async function startServer(configPath?: string): Promise<{
  app: CoreApp;
  config: MoltZapConfig;
  stop: () => Promise<void>;
}> {
  const runtimeConfig = await Effect.runPromise(
    loadRuntimeProcessConfig(
      configPath === undefined
        ? {}
        : { configPath: configPath as RuntimeConfigPath },
    ),
  );
  const observability = await Effect.runPromise(
    createRuntimeObservability(runtimeConfig),
  );
  const log = observability.logger;

  process.env["LOG_LEVEL"] = runtimeConfig.logging.level;
  process.env["NODE_ENV"] = runtimeConfig.environment;
  process.env["OTEL_SERVICE_NAME"] = runtimeConfig.tracing.serviceName;

  // Create database (PGlite if no URL, Postgres otherwise)
  const appConfig = runtimeConfig.app;
  const databaseUrl = runtimeConfig.server.database.url;
  const usePgLite = databaseUrl.length === 0;
  const handle = usePgLite
    ? await createPgLiteDb(appConfig.database?.data_dir)
    : await createPostgresDb(databaseUrl);

  if (usePgLite) {
    log.info("Using embedded PGlite database (no external Postgres needed)");
  }

  // Auto-migrate
  await Effect.runPromise(
    autoMigrateEffect(
      handle,
      runtimeConfig.server.encryption.masterSecret,
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // Build CoreConfig
  // Wire webhook services. UserService is part of CoreConfig (injected into
  // AppHost via Layer) because the admission path needs it at construction
  // time; other services (contacts, permissions) can be bound imperatively
  // after createCoreApp since they gate per-request behavior.
  const webhookClient = new WebhookClient();

  const userServiceCfg = appConfig.services?.users;
  const userService =
    userServiceCfg?.type === "webhook" && userServiceCfg.webhook_url
      ? new WebhookUserService(
          webhookClient,
          userServiceCfg.webhook_url,
          userServiceCfg.timeout_ms ?? 10000,
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
    dbCleanup: handle.cleanup,
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
        appConfig.services.contacts.timeout_ms ?? 10000,
        log,
      ),
    );
  }

  if (
    appConfig.services?.permissions?.type === "webhook" &&
    appConfig.services.permissions.webhook_url
  ) {
    const adapter = new AsyncWebhookAdapter();
    const token =
      appConfig.services.permissions.callback_token ?? crypto.randomUUID();
    const callbackBaseUrl = `http://127.0.0.1:${app.port}`;
    const permService = new WebhookPermissionService(
      adapter,
      appConfig.services.permissions.webhook_url,
      callbackBaseUrl,
      token,
      log,
    );
    app.setPermissionService(permService);
    app.setWebhookPermissionCallback(adapter, token);
  }

  // Register app manifests (resolve paths relative to config file location)
  if (appConfig.apps) {
    const configDir = runtimeConfig.configDirectory;
    const fsReadAppManifest = (manifestPath: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs
          .readFileString(manifestPath, "utf-8")
          .pipe(Effect.mapError((e) => new Error(e.message)));
      }).pipe(Effect.provide(NodeFileSystem.layer));

    for (const appRef of appConfig.apps) {
      const manifestPath = isAbsolute(appRef.manifest)
        ? appRef.manifest
        : resolve(configDir, appRef.manifest);
      const loadResult = await Effect.runPromise(
        fsReadAppManifest(manifestPath).pipe(
          Effect.map((json) => ({ ok: true as const, json })),
          Effect.catchAll((err) => Effect.succeed({ ok: false as const, err })),
        ),
      );
      if (!loadResult.ok) {
        log.error(
          { err: loadResult.err, path: appRef.manifest },
          "Failed to load app manifest",
        );
        continue;
      }
      try {
        const manifest = JSON.parse(loadResult.json);
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
