/** @file Vitest configuration for the cross-package process integration lane. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["sharness-test"] },
  ssr: { resolve: { conditions: ["sharness-test"] } },
  test: {
    include: ["**/*.integration.test.ts"],
    exclude: ["mixed-release/**"],
    maxWorkers: 2,
    passWithNoTests: false,
  },
});
