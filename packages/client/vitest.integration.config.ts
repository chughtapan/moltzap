/** @file Vitest configuration for the package integration suite. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["sharness-test"] },
  ssr: { resolve: { conditions: ["sharness-test"] } },
  test: {
    include: ["integration/**/*.integration.test.ts"],
    maxWorkers: 2,
    passWithNoTests: false,
  },
});
