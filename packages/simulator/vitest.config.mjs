import { defineConfig } from "vitest/config";
import {
  builtWorkspaceDependencies,
  workspaceSourceAliases,
} from "../../vitest.workspace-aliases.js";

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    server: {
      deps: {
        external: builtWorkspaceDependencies,
      },
    },
    include: ["src/**/*.test.ts"],
    // Cluster suites need a live cluster; `vitest.cluster.config.mjs` runs them.
    exclude: ["src/**/*.integration.test.ts", "src/**/*.cluster.test.ts"],
    coverage: {
      provider: "v8",
      // text-summary for a human reading the run; json-summary so a refactor can
      // be compared against a recorded baseline instead of a remembered one.
      reporter: ["text-summary", "json-summary"],
      // Covered by the root .gitignore `coverage` rule.
      reportsDirectory: "coverage",
      // The denominator is every source file, not only the ones a test happens to
      // import: a module that loses its last branch must not look the same as a
      // module that never had one. Workspace aliases resolve sibling packages'
      // sources, so the glob is anchored to this package.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.types-check.ts"],
    },
  },
});
