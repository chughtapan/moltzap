import { defineConfig } from "vitest/config";
import {
  serverCoreSourceAliases,
  workspaceSourceAliasesWithoutProtocol,
} from "../../vitest.workspace-aliases.js";

export default defineConfig({
  resolve: {
    alias: [
      ...serverCoreSourceAliases,
      ...workspaceSourceAliasesWithoutProtocol,
    ],
  },
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 180_000,
  },
});
