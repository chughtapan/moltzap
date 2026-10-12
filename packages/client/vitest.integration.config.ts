/** @file Vitest configuration for the package integration suite. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["integration/**/*.integration.test.ts"],
    maxWorkers: 2,
    passWithNoTests: false,
  },
});
