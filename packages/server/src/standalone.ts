/** Standalone server entry point — migrates DB, loads YAML config, starts the server, seeds agents. */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfigFromFile } from "./config/loader.js";
import { createCoreApp } from "./app/server.js";
import { seedAgents } from "./seed.js";
import { seedInitialKek } from "./crypto/key-rotation.js";
import { EnvelopeEncryption } from "./crypto/envelope.js";
import { createDb } from "./db/client.js";
import { logger } from "./logger.js";
import type { CoreConfig } from "./app/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findSchemaFile(): string {
  // Docker: copied to package root as core-schema.sql
  const dockerPath = join(__dirname, "..", "core-schema.sql");
  if (existsSync(dockerPath)) return dockerPath;
  // Dev mode (tsx): src/app/core-schema.sql relative to src/
  const devPath = join(__dirname, "app", "core-schema.sql");
  if (existsSync(devPath)) return devPath;
  throw new Error(
    "Cannot find core-schema.sql. Ensure it exists at the package root or in src/app/.",
  );
}

async function autoMigrate(
  databaseUrl: string,
  encryptionSecret: string,
): Promise<void> {
  // Raw pg pool for DDL — Kysely can't run before tables exist
  const migrationPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const exec = migrationPool.query.bind(migrationPool);
  try {
    const { rows } = await exec(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables WHERE table_name = 'agents'
       ) AS has_schema`,
    );
    if (rows[0].has_schema) {
      logger.info("Database schema already exists, skipping migration");
      return;
    }

    logger.info("Applying database schema...");
    const schema = readFileSync(findSchemaFile(), "utf-8");
    await exec(schema);

    // Seed the initial encryption key
    const db = createDb(databaseUrl);
    const envelope = new EnvelopeEncryption(encryptionSecret);
    await seedInitialKek(db, envelope);
    await db.destroy();

    logger.info("Database schema applied successfully");
  } finally {
    await migrationPool.end();
  }
}

const yamlConfig = loadConfigFromFile();

const config: CoreConfig = {
  databaseUrl: yamlConfig.database.url,
  encryptionMasterSecret: yamlConfig.encryption.master_secret,
  port: yamlConfig.server?.port ?? 3000,
  corsOrigins: yamlConfig.server?.cors_origins ?? ["*"],
  logLevel: yamlConfig.log_level,
  registration: yamlConfig.registration,
  seed: yamlConfig.seed,
  apps: yamlConfig.apps,
  services: yamlConfig.services,
};

// Auto-migrate, then start
await autoMigrate(config.databaseUrl, config.encryptionMasterSecret);

const app = createCoreApp(config);

// Register app manifests from config
if (yamlConfig.apps) {
  for (const appRef of yamlConfig.apps) {
    try {
      const manifestJson = readFileSync(appRef.manifest, "utf-8");
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

// Seed agents via the public API (idempotent)
if (yamlConfig.seed?.agents?.length) {
  const baseUrl = `http://127.0.0.1:${app.port}`;
  const db = createDb(yamlConfig.database.url);

  // Small delay to let the HTTP server bind
  setTimeout(async () => {
    try {
      await seedAgents({
        config: yamlConfig.seed!,
        db,
        baseUrl,
        registrationSecret: yamlConfig.registration?.secret,
        logger,
      });
    } catch (err) {
      logger.error({ err }, "Seed failed");
    } finally {
      await db.destroy();
    }
  }, 500);
}

logger.info(
  { port: app.port, mode: "standalone" },
  "MoltZap server started (standalone mode)",
);
