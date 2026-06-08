import { defineConfig } from "vitest/config";
import {
  serverCoreSourceAliases,
  workspaceSourceAliases,
} from "../../vitest.workspace-aliases.js";

const INTEGRATION_TEST_TIMEOUT_MS = 60_000;
const INTEGRATION_HOOK_TIMEOUT_MS = 60_000;

export default defineConfig({
  resolve: {
    alias: [...serverCoreSourceAliases, ...workspaceSourceAliases],
  },
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    globalSetup: ["vitest.integration.globalSetup.ts"],
    testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
    hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
    fileParallelism: true,
  },
});
