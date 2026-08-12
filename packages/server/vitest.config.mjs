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
    include: ["src/**/*.test.ts"],
  },
});
