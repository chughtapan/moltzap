/** @file Native provider tests run against the built Client public entry. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["**/*.test.ts"], exclude: ["dist/**", "node_modules/**"] },
});
