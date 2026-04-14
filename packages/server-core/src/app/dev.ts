/** Dev server entry point — `pnpm dev` runs this via tsx. */

import { loadCoreConfig } from "./config.js";
import { createCoreApp } from "./server.js";

const config = loadCoreConfig();
createCoreApp({
  databaseUrl: config.database.url,
  encryptionMasterSecret: config.encryption.masterSecret,
  port: config.server.port,
  corsOrigins: config.server.corsOrigins.exact,
  devMode: config.devMode,
});
