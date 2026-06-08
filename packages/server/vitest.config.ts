import { defineConfig } from "vitest/config";
import {
  serverCoreSourceAliases,
  workspaceSourceAliases,
} from "../../vitest.workspace-aliases.js";

export default defineConfig({
  resolve: {
    alias: [...serverCoreSourceAliases, ...workspaceSourceAliases],
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/__tests__/conformance/**", "src/__tests__/integration/**"],
  },
});
