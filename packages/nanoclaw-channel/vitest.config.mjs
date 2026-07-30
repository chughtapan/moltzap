import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [
      "src/__tests__/conformance/**",
      // Integration tests boot a real MoltZap server via the integration
      // globalSetup and only run under `vitest run --config
      // vitest.integration.config.ts`.
      "src/**/*.integration.test.ts",
    ],
  },
});
