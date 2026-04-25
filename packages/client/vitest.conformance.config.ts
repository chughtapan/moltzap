import { defineConfig } from "vitest/config";

/**
 * Client-side conformance vitest config (AC15 / spec #200).
 *
 * Scoped to the `src/__tests__/conformance/**` tree so `pnpm test`
 * (default config) keeps its own tree untouched. Also includes the
 * protocol package's executable client-side divergence proofs so CI
 * verifies the properties reject known-bad client behavior.
 */
export default defineConfig({
  test: {
    include: [
      "src/__tests__/conformance/**/*.test.ts",
      "../protocol/src/testing/conformance/__divergence_proofs__/client-executable.proofs.test.ts",
    ],
    testTimeout: 120_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    passWithNoTests: false,
  },
});
