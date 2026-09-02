/**
 * @file Driver for the per-folder MODULE.md generator.
 *
 * Reads the TypeDoc JSON cache, then renders every eligible folder's
 * MODULE.md + Mintlify MDX twin. Invoked by `pnpm docs:generate`
 * after TypeDoc writes the shared JSON cache. It is also available at
 * `tsx scripts/docs/generate-modules.ts`.
 *
 * Effect entry point: provide `NodeContext.layer` so FileSystem and
 * Path services resolve.
 */
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeFlowCoverage, printFlowCoverage } from "./flow-coverage.js";
import { writeModulesNav } from "./mintlify-nav.js";
import { generateModuleDocs, REQUIRED_PACKAGE_SUBPATHS } from "./modules.js";
import { loadTypeDoc } from "./typedoc-load.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(SCRIPT_DIR, "..", "..");
const CACHE_PATH = resolve(WORKSPACE_ROOT, "node_modules/.cache/typedoc.json");
const DOCS_MODULES_DIR = resolve(WORKSPACE_ROOT, "docs", "modules");
const DOCS_CONFIG_PATH = resolve(WORKSPACE_ROOT, "docs", "docs.json");

const program = Effect.gen(function* () {
  const cache = yield* loadTypeDoc(CACHE_PATH, {
    packageSubpaths: REQUIRED_PACKAGE_SUBPATHS,
  });
  const results = yield* generateModuleDocs(cache, {
    workspaceRoot: WORKSPACE_ROOT,
    docsModulesDir: DOCS_MODULES_DIR,
  });
  yield* writeModulesNav(
    DOCS_CONFIG_PATH,
    results.map((r) => r.pageSlug),
  );
  yield* Effect.sync(() => {
    process.stdout.write(
      `Rendered ${results.length} MODULE.md + MDX page(s); wrote the Modules group in ${DOCS_CONFIG_PATH}.\n`,
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
