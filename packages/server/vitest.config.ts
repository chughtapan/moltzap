import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "../../vitest.workspace-aliases.js";

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases,
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/__tests__/conformance/**", "src/__tests__/integration/**"],
  },
});
