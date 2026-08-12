import { defineConfig } from "vitest/config";
import {
  serverCoreSourceAliases,
  workspaceSourceAliasesWithoutProtocol,
} from "../../vitest.workspace-aliases.js";

const INSTALL_TEST_TIMEOUT_MS = 600_000;

export default defineConfig({
  resolve: {
    alias: [
      ...serverCoreSourceAliases,
      ...workspaceSourceAliasesWithoutProtocol,
    ],
  },
  test: {
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: INSTALL_TEST_TIMEOUT_MS,
  },
});
