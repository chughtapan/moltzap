/** @file Registers simulator-only NanoClaw extensions before the host loads. */
import { pathToFileURL } from "node:url";
import { installMoltZapConversationBootstrap } from "./bootstrap.mjs";
import { installProcessSessionDriver } from "./process-driver.mjs";

const appRoot = "/opt/moltzap/nanoclaw/app";
const moduleUrl = (relativePath) =>
  pathToFileURL(`${appRoot}/dist/${relativePath}`).href;

// Load stock registration first; the MoltZap interceptor deliberately replaces
// no permission primitive and participates through the channel-card seam.
await import(moduleUrl("modules/index.js"));
await import(moduleUrl("channels/moltzap.js"));

const [registry, types] = await Promise.all([
  import(moduleUrl("drivers/driver-registry.js")),
  import(moduleUrl("drivers/types.js")),
]);
installProcessSessionDriver({
  registerSessionDriver: registry.registerSessionDriver,
  validateSpec: types.validateSpec,
  specInvalid: types.specInvalid,
});
await installMoltZapConversationBootstrap({ appRoot });
