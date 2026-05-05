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
      "@typescript-eslint/no-magic-numbers": [
        "warn",
        {
          ignore: [-1, 0, 1],
          ignoreArrayIndexes: true,
        },
      ],
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
  // Exempts `*.types-check.ts` canaries — they import across layers on
  // purpose to verify the boundary fails to type-check.
  {
    files: ["packages/server/src/network/**/*.ts"],
    ignores: ["packages/server/src/network/**/*.types-check.ts"],
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
                "**/app/handlers/**",
                "../app/handlers/**",
                "../../app/handlers/**",
                "../../../app/handlers/**",
              ],
              message:
                "packages/server/src/network/** may not import from the task or app/handlers subtrees (spec #135 AC7/AC8). The network layer sits below task and app; see packages/server/src/network/tsconfig.json and packages/server/src/rpc/layer-scopes.ts.",
            },
          ],
        },
      ],
    },
  },

  // Block 5: task -> app boundary.
  // Task handlers may use the app/ shared layers (ConnIdTag etc.) but must
  // not depend on app/handlers. Pairs with the network rule above and with
  // the Effect Context tag in packages/server/src/task/layer-scope.ts.
  {
    files: ["packages/server/src/task/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/app/handlers/**",
                "../app/handlers/**",
                "../../app/handlers/**",
                "../../../app/handlers/**",
              ],
              message:
                "packages/server/src/task/** may not import from the app/handlers subtree. Task sits below app; see packages/server/src/task/tsconfig.json and packages/server/src/rpc/layer-scopes.ts.",
            },
          ],
        },
      ],
    },
  },
];
