import { defineConfig } from "vitest/config";

/**
 * Client-side conformance vitest config (AC15 / spec #200).
 *
 * Scoped to the `src/__tests__/conformance/**` tree so `pnpm test`
 * (default config) keeps its own tree untouched. Also includes the
 * protocol package's client-side divergence proofs so flat re-parse
 * catches import drift (architect-201 §5).
 */
export default defineConfig({
  test: {
    include: [
      "src/__tests__/conformance/**/*.test.ts",
      "../protocol/src/testing/conformance/__divergence_proofs__/client-*.proofs.ts",
    ],
    testTimeout: 120_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    passWithNoTests: false,
  },
});
