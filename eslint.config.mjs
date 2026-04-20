import guard from "eslint-plugin-agent-code-guard";
import tsParser from "@typescript-eslint/parser";
import comments from "@eslint-community/eslint-plugin-eslint-comments";
import tseslint from "@typescript-eslint/eslint-plugin";
import sonarjs from "eslint-plugin-sonarjs";

export default [
  // Global ignores: built artifacts and generated files are not linted.
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"],
  },

  // Block 1: application source across all packages.
  {
    files: ["packages/*/src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.spec.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: {
      "agent-code-guard": guard,
      "@typescript-eslint": tseslint,
      sonarjs,
    },
    rules: {
      ...guard.configs.recommended.rules,
      "@typescript-eslint/no-magic-numbers": "warn",
      "@typescript-eslint/no-unused-vars": "error",
      "sonarjs/no-duplicate-string": ["warn", { threshold: 4 }],
    },
  },

  // Block 2: integration tests — no-vitest-mocks applies here.
  {
    files: ["packages/*/src/**/*.integration.test.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { "agent-code-guard": guard },
    rules: guard.configs.integrationTests.rules,
  },

  // Block 3: every .ts file must have a description on any eslint-disable comment.
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { "eslint-comments": comments },
    rules: {
      "eslint-comments/require-description": ["error", { ignore: [] }],
    },
  },

  // Block 4: network <-> task boundary (spec #135 AC8).
  // Defense-in-depth over the TS project-reference boundary in the subtree
  // tsconfigs; this gives reviewers a faster lint-time signal.
  {
    files: ["packages/server/src/network/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/task/**",
                "../task/**",
                "../../task/**",
                "../../../task/**",
              ],
              message:
                "packages/server/src/network/** may not import from the task subtree (spec #135 AC7/AC8). The network -> task direction is forbidden; see also the TS project-reference boundary in packages/server/src/network/tsconfig.json.",
            },
          ],
        },
      ],
    },
  },
];
