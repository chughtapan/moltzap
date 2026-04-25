import { defineConfig } from "vitest/config";

/**
 * OpenClaw channel client-side conformance vitest config (AC16).
 * Scoped to the `src/__tests__/conformance/**` tree; reuses the
 * protocol package's executable client divergence proofs.
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
