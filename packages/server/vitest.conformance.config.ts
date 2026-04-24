import { defineConfig } from "vitest/config";

/**
 * Dedicated vitest config for the protocol conformance suite. Scoped to
 * `src/__tests__/conformance/**` so `pnpm test` (default config) and
 * `pnpm test:integration` (existing integration suite) continue running
 * their own trees uncontaminated. AC12 regression guarantee lives on the
 * default configs; this one is the single entry point for
 * `pnpm -F @moltzap/server-core test:conformance`.
 */
export default defineConfig({
  test: {
    include: ["src/__tests__/conformance/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
