import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const workspaceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const workspaceModules = Object.freeze({
  "@moltzap/client": join(workspaceRoot, "packages/client/dist/index.js"),
  "@moltzap/simulator/network": join(
    workspaceRoot,
    "packages/simulator/dist/network/index.js",
  ),
  effect: join(
    workspaceRoot,
    "packages/simulator/node_modules/effect/dist/esm/index.js",
  ),
});

export function resolve(specifier, context, nextResolve) {
  const workspaceModule = workspaceModules[specifier];
  return workspaceModule === undefined
    ? nextResolve(specifier, context)
    : { shortCircuit: true, url: pathToFileURL(workspaceModule).href };
}
