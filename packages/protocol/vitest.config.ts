import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "../../vitest.workspace-aliases.js";

export default defineConfig({
  // Conformance fixtures import the package's own subpaths
  // (`@moltzap/protocol/task`, `/network`); resolve them to `src/` so the suite
  // runs without a built `dist/`, matching every other package's vitest config.
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
