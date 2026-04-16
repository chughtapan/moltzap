import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    globalSetup: ["vitest.integration.globalSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: true,
  },
});
