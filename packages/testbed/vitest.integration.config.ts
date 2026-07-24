import { defineConfig } from "vitest/config";

const NANOCLAW_INSTALL_TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: NANOCLAW_INSTALL_TEST_TIMEOUT_MS,
  },
});
