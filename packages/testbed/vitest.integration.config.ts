import { defineConfig } from "vitest/config";

// A cold published-plugin install runs a real npm install (measured ~60s)
// before the assertions it feeds.
const INSTALL_TEST_TIMEOUT_MS = 600_000;

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: INSTALL_TEST_TIMEOUT_MS,
  },
});
