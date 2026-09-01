/** @file Registers the NanoClaw channel and process-session driver. */
import { pathToFileURL } from "node:url";
import { installProcessSessionDriver } from "./process-driver.mjs";

const appRoot = "/opt/moltzap/nanoclaw/app";
const moduleUrl = (relativePath) =>
  pathToFileURL(`${appRoot}/dist/${relativePath}`).href;

// Load stock registration before installing the image's session driver.
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
