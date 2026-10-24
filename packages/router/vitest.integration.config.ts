/** @file Vitest configuration for the package integration suite. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["sharness-test"] },
  ssr: { resolve: { conditions: ["sharness-test"] } },
  test: {
    include: ["src/**/*.integration.test.ts"],
    passWithNoTests: false,
  },
});
