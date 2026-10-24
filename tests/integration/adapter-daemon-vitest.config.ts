/** @file Vitest boundary for the real-daemon adapter acceptance lane. */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(SCRIPT_DIRECTORY, "..", "..");

export default defineConfig({
  root: WORKSPACE_ROOT,
  resolve: {
    conditions: ["sharness-test"],
    alias: [
      {
        find: /^@moltzap\/client$/u,
        replacement: resolve(WORKSPACE_ROOT, "packages/client/src/index.ts"),
      },
      {
        find: /^@moltzap\/openclaw-channel$/u,
        replacement: resolve(
          WORKSPACE_ROOT,
          "packages/openclaw-channel/src/index.ts",
        ),
      },
    ],
  },
  ssr: { resolve: { conditions: ["sharness-test"] } },
  test: {
    include: ["tests/integration/adapter-daemon-process.integration.test.ts"],
    maxWorkers: 1,
    passWithNoTests: false,
  },
});
