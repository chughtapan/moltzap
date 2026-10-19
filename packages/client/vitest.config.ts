/** @file Vitest configuration for the package unit suite. */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/transport/wire/acceptance.test.ts"],
        },
      },
      {
        resolve: {
          alias: [
            {
              find: /^@moltzap\/identity$/u,
              replacement: fileURLToPath(
                new URL("../identity/src/index.ts", import.meta.url),
              ),
            },
          ],
        },
        test: {
          name: "wire-versions",
          include: ["src/transport/wire/acceptance.test.ts"],
        },
      },
    ],
  },
});
