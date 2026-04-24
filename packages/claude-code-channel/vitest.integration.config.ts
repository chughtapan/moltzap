import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["vitest.integration.globalSetup.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 300_000,
    globalSetupTimeout: 300_000,
  },
});
