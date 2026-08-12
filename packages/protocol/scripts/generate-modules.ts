/**
 * @file Driver for the per-folder MODULE.md generator.
 *
 * Reads the TypeDoc JSON cache, then renders every eligible folder's
 * MODULE.md + Mintlify MDX twin. Intended to be invoked from
 * `pnpm docs:generate` after the existing RPC method/notification
 * rendering pass. It is also available as a standalone script at
 * `tsx packages/protocol/scripts/generate-modules.ts`.
 *
 * Effect entry point: provide `NodeContext.layer` so FileSystem and
 * Path services resolve.
 */
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeFlowCoverage,
  printFlowCoverage,
} from "./docs/flow-coverage.js";
import { writeModulesNav } from "./docs/mintlify-nav.js";
import {
  generateModuleDocs,
  REQUIRED_PACKAGE_SUBPATHS,
} from "./docs/modules.js";
import { loadTypeDoc } from "./docs/typedoc-load.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const CACHE_PATH = resolve(WORKSPACE_ROOT, "node_modules/.cache/typedoc.json");
const DOCS_MODULES_DIR = resolve(WORKSPACE_ROOT, "docs", "modules");
const NAV_PATH = resolve(DOCS_MODULES_DIR, "_nav.json");

const program = Effect.gen(function* () {
  const cache = yield* loadTypeDoc(CACHE_PATH, {
    packageSubpaths: REQUIRED_PACKAGE_SUBPATHS,
  });
  const results = yield* generateModuleDocs(cache, {
    workspaceRoot: WORKSPACE_ROOT,
    docsModulesDir: DOCS_MODULES_DIR,
  });
  yield* writeModulesNav(
    NAV_PATH,
    results.map((r) => r.pageSlug),
  );
  yield* Effect.sync(() => {
    process.stdout.write(
      `Rendered ${results.length} MODULE.md + MDX page(s); wrote ${NAV_PATH}.\n`,
    );
    for (const r of results) {
      process.stdout.write(`  ${r.folder} → ${r.pageSlug}\n`);
    }
  });
  const gaps = computeFlowCoverage(cache);
  yield* printFlowCoverage(gaps);
});

NodeRuntime.runMain(
  program.pipe(Effect.provide(Layer.merge(NodeContext.layer, Layer.empty))),
);
