import { defineConfig } from "vitest/config";

/**
 * Dedicated Vitest config for the conformance suite. Running it inside
 * Vitest lets us re-use the `expectRpcFailure` test-utility (which imports
 * `vitest` at module load) without shipping a vitest shim.
 *
 * Triggered via `pnpm -F @moltzap/protocol test:conformance`.
 * `pnpm test` uses the default `vitest.config` (unit tests only) so
 * regression flow is unchanged (AC12).
 */
export default defineConfig({
  test: {
    include: ["scripts/conformance.entry.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // The conformance entry sequences its own tiers; disable parallelism.
    fileParallelism: false,
  },
});
