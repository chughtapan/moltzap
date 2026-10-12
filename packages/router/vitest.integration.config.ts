/** @file Vitest configuration for the package integration suite. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts", "src/**/*.e2e.test.ts"],
    passWithNoTests: false,
  },
});
