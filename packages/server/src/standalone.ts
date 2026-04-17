/** Standalone server — loads YAML config, boots PGlite or Postgres, starts the server. */

import { existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Duration, Effect } from "effect";
import { FileSystem, HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import { loadConfigFromFile } from "./config/loader.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Database factory ────────────────────────────────────────────────

interface DbHandle {
  db: Kysely<Database>;
  cleanup: () => Promise<void>;
  runMigrationSql: (sql: string) => Promise<void>;
}

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: PGlite dynamic import + pool init boundary
async function createPgLiteDb(dataDir?: string): Promise<DbHandle> {
  const { KyselyPGlite } = await import("kysely-pglite");

  const kpg = dataDir
    ? await KyselyPGlite.create(dataDir)
    : await KyselyPGlite.create();

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
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          Effect.flatMap(() =>
            Effect.tryPromise({
              try: () => kpg.client.close(),
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            }),
          ),
        ),
      ),
    runMigrationSql: (sqlText: string) =>
      Effect.runPromise(
        Effect.tryPromise({
          try: () => kpg.client.exec(sqlText),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(Effect.asVoid),
      ),
  };
}

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: pg dynamic import + Pool init boundary
async function createPostgresDb(url: string): Promise<DbHandle> {
  const pg = await import("pg");
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
    // #ignore-sloppy-code-next-line[async-keyword]: pg pool.query callback-to-Promise boundary
    runMigrationSql: async (sqlText: string) => {
      // Raw DDL — Kysely can't run before tables exist
      const exec = pool.query.bind(pool);
      await exec(sqlText);
    },
  };
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

// ── Seed ────────────────────────────────────────────────────────────

interface RegisterResponse {
  agentId: string;
  apiKey: string;
}

/**
 * Register seed agents over HTTP against the already-bound local server. Uses
 * `@effect/platform` HttpClient so transport errors are typed. Per-agent
 * failures are logged and dropped — seeding is best-effort.
 */
function seedAgentsEffect(
  config: MoltZapConfig,
  db: Kysely<Database>,
  baseUrl: string,
): Effect.Effect<void, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const agents = config.seed?.agents;
    if (!agents?.length) return;

    const secret = config.registration?.secret;
    const client = yield* HttpClient.HttpClient;

    const seedOne = (agentDef: { name: string; description?: string }) =>
      Effect.gen(function* () {
        const existing = yield* Effect.tryPromise({
          try: () =>
            db
              .selectFrom("agents")
              .where("name", "=", agentDef.name)
              .select("id")
              .executeTakeFirst(),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        });

        if (existing) {
          logger.info({ name: agentDef.name }, "Seed agent already exists");
          return;
        }

        const body: Record<string, string> = { name: agentDef.name };
        if (agentDef.description) body["description"] = agentDef.description;
        if (secret) body["inviteCode"] = secret;

        const request = HttpClientRequest.post(
          `${baseUrl}/api/v1/auth/register`,
        ).pipe(HttpClientRequest.bodyUnsafeJson(body));
        const response = yield* client.execute(request);
        if (response.status < 200 || response.status >= 300) {
          const text = yield* response.text.pipe(
            Effect.catchAll(() => Effect.succeed("")),
          );
          logger.error(
            { name: agentDef.name, status: response.status, body: text },
            "Failed to register seed agent",
          );
          return;
        }
        const result = (yield* response.json) as RegisterResponse;
        logger.info(
          { name: agentDef.name, agentId: result.agentId },
          "Seed agent created",
        );
        logger.debug(
          { name: agentDef.name, apiKey: result.apiKey },
          "Seed agent API key: %s",
          result.apiKey,
        );
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() =>
            logger.error(
              { err, name: agentDef.name },
              "Seed agent task failed",
            ),
          ),
        ),
      );

    yield* Effect.forEach(agents, seedOne, {
      concurrency: "unbounded",
      discard: true,
    });
  });
}

/**
 * Poll `/health` until the server is ready; fail after `retries` attempts.
 */
function waitForReadyEffect(
  baseUrl: string,
  retries: number,
): Effect.Effect<void, Error, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    for (let i = 0; i < retries; i++) {
      const result = yield* client
        .execute(HttpClientRequest.get(`${baseUrl}/health`))
        .pipe(
          Effect.map((res) => res.status >= 200 && res.status < 300),
          Effect.catchAll((err) => {
            logger.debug({ err, attempt: i + 1 }, "Server not ready yet");
            return Effect.succeed(false);
          }),
        );
      if (result) return;
      yield* Effect.sleep(Duration.millis(200));
    }
    return yield* Effect.fail(new Error("Server did not become ready in time"));
  });
}

// ── Main ────────────────────────────────────────────────────────────

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: Node process entrypoint for standalone server
export async function startServer(configPath?: string): Promise<{
  app: CoreApp;
  config: MoltZapConfig;
  stop: () => Promise<void>;
}> {
  const yamlConfig = await Effect.runPromise(loadConfigFromFile(configPath));

  // Create database (PGlite if no URL, Postgres otherwise)
  // DATABASE_URL env var is a fallback when YAML doesn't specify database.url
  const databaseUrl = yamlConfig.database?.url || process.env["DATABASE_URL"];
  const usePgLite = !databaseUrl;
  const handle = usePgLite
    ? await createPgLiteDb(yamlConfig.database?.data_dir)
    : await createPostgresDb(databaseUrl!);

  if (usePgLite) {
    logger.info("Using embedded PGlite database (no external Postgres needed)");
  }

  // Auto-migrate
  await Effect.runPromise(
    autoMigrateEffect(handle, yamlConfig.encryption?.master_secret).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

  // Build CoreConfig
  // Wire webhook services. UserService is part of CoreConfig (injected into
  // AppHost via Layer) because the admission path needs it at construction
  // time; other services (contacts, permissions) can be bound imperatively
  // after createCoreApp since they gate per-request behavior.
  const webhookClient = new WebhookClient();

  const userServiceCfg = yamlConfig.services?.users;
  const userService =
    userServiceCfg?.type === "webhook" && userServiceCfg.webhook_url
      ? new WebhookUserService(
          webhookClient,
          userServiceCfg.webhook_url,
          userServiceCfg.timeout_ms ?? 10000,
          logger,
        )
      : undefined;

  const coreConfig: CoreConfig = {
    db: handle.db,
    dbCleanup: handle.cleanup,
    encryptionMasterSecret: yamlConfig.encryption?.master_secret,
    port: yamlConfig.server?.port ?? 41973,
    corsOrigins: yamlConfig.server?.cors_origins ?? ["*"],
    registrationSecret: yamlConfig.registration?.secret,
    userService,
    webhookClient,
  };

  const app = createCoreApp(coreConfig);

  if (
    yamlConfig.services?.contacts?.type === "webhook" &&
    yamlConfig.services.contacts.webhook_url
  ) {
    app.setContactService(
      new WebhookContactService(
        webhookClient,
        yamlConfig.services.contacts.webhook_url,
        yamlConfig.services.contacts.timeout_ms ?? 10000,
        logger,
      ),
    );
  }

  if (
    yamlConfig.services?.permissions?.type === "webhook" &&
    yamlConfig.services.permissions.webhook_url
  ) {
    const adapter = new AsyncWebhookAdapter();
    const token =
      yamlConfig.services.permissions.callback_token ?? crypto.randomUUID();
    const callbackBaseUrl = `http://127.0.0.1:${app.port}`;
    const permService = new WebhookPermissionService(
      adapter,
      yamlConfig.services.permissions.webhook_url,
      callbackBaseUrl,
      token,
      logger,
    );
    app.setPermissionService(permService);
    app.setWebhookPermissionCallback(adapter, token);
  }

  // Register app manifests (resolve paths relative to config file location)
  if (yamlConfig.apps) {
    const configDir = yamlConfig._configDir;
    const fsReadAppManifest = (manifestPath: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs
          .readFileString(manifestPath, "utf-8")
          .pipe(Effect.mapError((e) => new Error(e.message)));
      }).pipe(Effect.provide(NodeFileSystem.layer));

    for (const appRef of yamlConfig.apps) {
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
        logger.error(
          { err: loadResult.err, path: appRef.manifest },
          "Failed to load app manifest",
        );
        continue;
      }
      try {
        const manifest = JSON.parse(loadResult.json);
        app.registerApp(manifest);
        logger.info(
          { appId: manifest.appId, path: appRef.manifest },
          "App manifest registered",
        );
      } catch (err) {
        logger.error(
          { err, path: appRef.manifest },
          "Failed to load app manifest",
        );
      }
    }
  }

  // Seed agents (after server is listening)
  if (yamlConfig.seed?.agents?.length) {
    const baseUrl = `http://127.0.0.1:${app.port}`;
    // Wait for the server to be ready, then seed. Fire-and-forget at the
    // process edge; logs are the feedback loop.
    const seedTask = waitForReadyEffect(baseUrl, 10).pipe(
      Effect.flatMap(() => seedAgentsEffect(yamlConfig, handle.db, baseUrl)),
      Effect.provide(NodeHttpClient.layer),
      Effect.catchAll((err) =>
        Effect.sync(() => logger.error({ err }, "Seed failed")),
      ),
    );
    Effect.runFork(seedTask);
  }

  logger.info(
    {
      port: app.port,
      mode: "standalone",
      db: usePgLite ? "pglite" : "postgres",
    },
    "MoltZap server started (standalone mode)",
  );

  return {
    app,
    config: yamlConfig,
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
