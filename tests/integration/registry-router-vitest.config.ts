/** @file Registry and Router interoperability through their public clients. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["sharness-test"] },
  ssr: { resolve: { conditions: ["sharness-test"] } },
  test: {
    include: ["registry-router.integration.test.ts"],
    passWithNoTests: false,
  },
});
