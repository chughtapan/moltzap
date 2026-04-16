/** Standalone server entry point — loads YAML config, starts the server, seeds agents. */

import { readFileSync } from "node:fs";
import { loadConfigFromFile } from "./config/loader.js";
import { createCoreApp } from "./app/server.js";
import { seedAgents } from "./seed.js";
import { createDb } from "./db/client.js";
import { logger } from "./logger.js";
import type { CoreConfig } from "./app/types.js";

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
