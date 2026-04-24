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
    // The suite `*.test.ts` file drives real server traffic against
    // the protocol conformance properties. The `*.proofs.ts` files
    // under `packages/protocol` are the divergence proofs
    // (architect #195 §5 + #197 §5): every test is wrapped in
    // `describe.skip` so a full run reports 21 skipped / 0 executed,
    // but vitest still parses and type-resolves them — catching
    // import drift the grep gate can't see. Flip a `.skip → .only`
    // for the author workflow.
    include: [
      "src/__tests__/conformance/**/*.test.ts",
      "../protocol/src/testing/conformance/__divergence_proofs__/**/*.proofs.ts",
    ],
    testTimeout: 120_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    // Zero-file exit used to silently pass (the old include glob
    // missed the proof files). Fail loudly if the include regresses.
    passWithNoTests: false,
  },
});
