import { defineConfig } from "vitest/config";

/** Client-side conformance was retired with the typed Effect RPC transport. */
export default defineConfig({
  test: {
    include: ["src/__tests__/conformance/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    passWithNoTests: true,
  },
});
