/** Standalone server — loads YAML config, boots PGlite or Postgres, starts the server. */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect, sql } from "kysely";
import { loadConfigFromFile } from "./config/loader.js";
import type { MoltZapConfig } from "./config/schema.js";
import { createCoreApp } from "./app/server.js";
import { seedInitialKek } from "./crypto/key-rotation.js";
import { EnvelopeEncryption } from "./crypto/envelope.js";
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

async function createPgLiteDb(dataDir?: string): Promise<DbHandle> {
  const { KyselyPGlite } = await import("kysely-pglite");

  const kpg = dataDir
    ? await KyselyPGlite.create(dataDir)
    : await KyselyPGlite.create();

  const db = new Kysely<Database>({ dialect: kpg.dialect });

  return {
    db,
    cleanup: async () => {
      await db.destroy();
      await kpg.client.close();
    },
    runMigrationSql: async (sqlText: string) => {
      await kpg.client.exec(sqlText);
    },
  };
}

async function createPostgresDb(url: string): Promise<DbHandle> {
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: url, max: 20 });
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  return {
    db,
    cleanup: async () => {
      await db.destroy();
    },
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

async function autoMigrate(
  handle: DbHandle,
  encryptionSecret?: string,
): Promise<void> {
  const result = await sql<{ has_schema: boolean }>`
    SELECT EXISTS (
      SELECT FROM information_schema.tables WHERE table_name = 'agents'
    ) AS has_schema
  `.execute(handle.db);

  if (result.rows[0]?.has_schema) {
    logger.info("Database schema already exists, skipping migration");
    return;
  }

  logger.info("Applying database schema...");
  const schema = readFileSync(findSchemaFile(), "utf-8");
  await handle.runMigrationSql(schema);

  if (encryptionSecret) {
    const envelope = new EnvelopeEncryption(encryptionSecret);
    await seedInitialKek(handle.db, envelope);
  } else {
    logger.info(
      "Encryption not configured — messages will be stored as plaintext",
    );
  }

  logger.info("Database schema applied successfully");
}

// ── Seed ────────────────────────────────────────────────────────────

interface RegisterResponse {
  agentId: string;
  apiKey: string;
}

async function seedAgents(
  config: MoltZapConfig,
  db: Kysely<Database>,
  baseUrl: string,
): Promise<void> {
  const agents = config.seed?.agents;
  if (!agents?.length) return;

  const secret = config.registration?.secret;

  const seedOne = async (agentDef: { name: string; description?: string }) => {
    const existing = await db
      .selectFrom("agents")
      .where("name", "=", agentDef.name)
      .select("id")
      .executeTakeFirst();

    if (existing) {
      logger.info({ name: agentDef.name }, "Seed agent already exists");
      return;
    }

    const body: Record<string, string> = { name: agentDef.name };
    if (agentDef.description) body["description"] = agentDef.description;
    if (secret) body["inviteCode"] = secret;

    const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error(
        { name: agentDef.name, status: res.status, body: text },
        "Failed to register seed agent",
      );
      return;
    }

    const result = (await res.json()) as RegisterResponse;
    logger.info(
      { name: agentDef.name, agentId: result.agentId },
      "Seed agent created",
    );
    logger.debug(
      { name: agentDef.name, apiKey: result.apiKey },
      "Seed agent API key: %s",
      result.apiKey,
    );
  };

  await Promise.allSettled(agents.map(seedOne));
}

// ── Main ────────────────────────────────────────────────────────────

export async function startServer(configPath?: string): Promise<{
  app: CoreApp;
  config: MoltZapConfig;
  stop: () => Promise<void>;
}> {
  const yamlConfig = loadConfigFromFile(configPath);

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
  await autoMigrate(handle, yamlConfig.encryption?.master_secret);

  // Build CoreConfig
  const coreConfig: CoreConfig = {
    db: handle.db,
    dbCleanup: handle.cleanup,
    encryptionMasterSecret: yamlConfig.encryption?.master_secret,
    port: yamlConfig.server?.port ?? 41973,
    corsOrigins: yamlConfig.server?.cors_origins ?? ["*"],
    registrationSecret: yamlConfig.registration?.secret,
  };

  const app = createCoreApp(coreConfig);

  // Wire webhook services
  const webhookClient = new WebhookClient();

  if (
    yamlConfig.services?.users?.type === "webhook" &&
    yamlConfig.services.users.webhook_url
  ) {
    app.setUserService(
      new WebhookUserService(
        webhookClient,
        yamlConfig.services.users.webhook_url,
        yamlConfig.services.users.timeout_ms ?? 10000,
        logger,
      ),
    );
  }

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
    for (const appRef of yamlConfig.apps) {
      try {
        const manifestPath = isAbsolute(appRef.manifest)
          ? appRef.manifest
          : resolve(configDir, appRef.manifest);
        const manifestJson = readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestJson);
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
    // Wait for the server to be ready before seeding
    const waitForReady = async (retries = 10): Promise<void> => {
      for (let i = 0; i < retries; i++) {
        try {
          const res = await fetch(`${baseUrl}/health`);
          if (res.ok) return;
        } catch (err) {
          logger.debug({ err, attempt: i + 1 }, "Server not ready yet");
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("Server did not become ready in time");
    };
    waitForReady()
      .then(() => seedAgents(yamlConfig, handle.db, baseUrl))
      .catch((err) => logger.error({ err }, "Seed failed"));
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
    stop: async () => {
      await app.close();
    },
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
