import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "../../vitest.workspace-aliases.js";

// Opt-in suites that assert against a live local cluster. They are not part of
// the default test target: each one creates real Kubernetes objects, kills real
// processes, and takes minutes rather than milliseconds.
export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    include: ["src/**/*.cluster.test.ts"],
    // One run's controller Job, its reclamation, and the Kubernetes deletion
    // that follows are all measured in minutes.
    testTimeout: 900_000,
    hookTimeout: 900_000,
    // One cluster, one Temporal task queue: concurrent suites would observe
    // each other's namespaces.
    fileParallelism: false,
  },
});
