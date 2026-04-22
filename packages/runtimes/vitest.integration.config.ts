import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "../../vitest.workspace-aliases.js";

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 180_000,
  },
});
