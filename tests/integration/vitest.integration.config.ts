/** @file Vitest configuration for the package integration suite. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["sharness-test"] },
  ssr: { resolve: { conditions: ["sharness-test"] } },
  test: {
    include: ["*.integration.test.ts", "*.e2e.test.ts"],
    exclude: [
      "mixed-release.integration.test.ts",
      "adapter-daemon-process.integration.test.ts",
    ],
    maxWorkers: 2,
    passWithNoTests: false,
  },
});
