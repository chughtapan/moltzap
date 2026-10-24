/** @file Preserve process fixtures' rules from their owning lint scopes. */
import type { Linter } from "eslint";
import { matchesGlob } from "node:path";
import { rootEslintConfig } from "../../eslint.shared.js";
import clientConfig from "../../packages/client/eslint.config.js";
import routerConfig from "../../packages/router/eslint.config.js";

export default [
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"] },
  ...relocateConfig(
    clientConfig,
    [
      "all-gather.integration.test.ts",
      "daemon-process-harness.ts",
      "daemon-process.integration.test.ts",
      "editable-policy.integration.test.ts",
      "firewall-collectives.integration.test.ts",
      "firewall-daemon.ts",
      "gather.integration.test.ts",
      "held-delivery.integration.test.ts",
      "loopback-server.ts",
      "message-policy-file.integration.test.ts",
      "otlp-receiver.ts",
      "participants.ts",
      "process-feedback.integration.test.ts",
      "router-hold-proxy.ts",
      "telemetry.integration.test.ts",
    ],
    "integration/",
  ),
  ...relocateConfig(
    rootEslintConfig(import.meta.dirname),
    [
      "adapter-daemon-fixture.ts",
      "adapter-daemon-process.integration.test.ts",
      "adapter-daemon-vitest.config.ts",
      "mixed-release-vitest.config.ts",
      "mixed-release.integration.test.ts",
    ],
    "scripts/test/",
  ),
  ...relocateConfig(
    clientConfig,
    ["eslint.config.ts", "vitest.integration.config.ts"],
    "",
  ),
  ...relocateConfig(
    routerConfig,
    ["client-version-roundtrip.ts"],
    "src/router/__tests__/integration/",
  ),
  ...relocateConfig(
    routerConfig,
    ["registry-router.e2e.test.ts"],
    "src/router/__tests__/",
  ),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.adapter-daemon.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];

/** Match selectors at the owning path so relocation preserves every override. */
function relocateConfig(
  configs: readonly Linter.Config[],
  fixtures: readonly string[],
  directory: string,
): Linter.Config[] {
  return configs.flatMap((config) => {
    const files = fixtures.filter((file) => {
      const original = `${directory}${file}`;
      return (
        (config.files === undefined ||
          config.files.some(
            (pattern) =>
              typeof pattern === "string" && matchesGlob(original, pattern),
          )) &&
        !config.ignores?.some((pattern) => matchesGlob(original, pattern))
      );
    });
    return files.length === 0 ? [] : [{ ...config, files, ignores: [] }];
  });
}
