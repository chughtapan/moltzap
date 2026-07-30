import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "../../vitest.workspace-aliases.js";

const INSTALL_TEST_TIMEOUT_MS = 600_000;

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: INSTALL_TEST_TIMEOUT_MS,
  },
});
