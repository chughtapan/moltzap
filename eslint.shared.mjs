import guard from "eslint-plugin-agent-code-guard";
import tsParser from "@typescript-eslint/parser";
import comments from "@eslint-community/eslint-plugin-eslint-comments";
import tseslint from "@typescript-eslint/eslint-plugin";

const tsLanguageOptions = {
  parser: tsParser,
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
};

const packageIgnores = {
  ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"],
};

const architectureRuleNames = new Set(
  Object.keys(guard.configs.architecture.rules),
);

const recommendedSourceRules = Object.fromEntries(
  Object.entries(guard.configs.recommended.rules).filter(
    ([ruleName]) => !architectureRuleNames.has(ruleName),
  ),
);

const sourceRules = {
  ...recommendedSourceRules,
  "@typescript-eslint/no-magic-numbers": [
    "warn",
    {
      ignore: [-1, 0, 1],
      ignoreArrayIndexes: true,
      ignoreReadonlyClassProperties: true,
    },
  ],
  "@typescript-eslint/no-unused-vars": "error",
  "sonarjs/no-duplicate-string": ["warn", { threshold: 4 }],
};

const testSupportRules = {
  files: [
    "src/**/*.test.ts",
    "src/**/*.spec.ts",
    "src/**/*.integration.test.ts",
    "src/**/*.int.test.ts",
    "src/__tests__/**/*.ts",
    "src/**/__tests__/**/*.ts",
    "src/testing/**/*.ts",
    "src/test-utils/**/*.ts",
  ],
  plugins: guard.configs.recommended.plugins,
  rules: {
    "@typescript-eslint/no-magic-numbers": "off",
    "sonarjs/no-nested-functions": ["error", { threshold: 5 }],
  },
};

const eslintDisableCommentRules = {
  files: ["**/*.ts"],
  languageOptions: tsLanguageOptions,
  plugins: { "eslint-comments": comments },
  rules: {
    "eslint-comments/require-description": ["error", { ignore: [] }],
  },
};

const integrationTestRules = {
  files: ["src/**/*.integration.test.ts"],
  languageOptions: tsLanguageOptions,
  plugins: guard.configs.integrationTests.plugins,
  rules: guard.configs.integrationTests.rules,
};

export function packageEslintConfig() {
  return [
    packageIgnores,
    {
      files: ["src/**/*.ts"],
      ignores: ["**/*.test.ts", "**/*.spec.ts"],
      languageOptions: tsLanguageOptions,
      plugins: {
        ...guard.configs.recommended.plugins,
        "@typescript-eslint": tseslint,
      },
      settings: guard.configs.recommended.settings,
      rules: sourceRules,
    },
    integrationTestRules,
    testSupportRules,
    eslintDisableCommentRules,
  ];
}

export function rootEslintConfig() {
  return [
    packageIgnores,
    {
      files: ["scripts/**/*.ts", "*.ts"],
      languageOptions: tsLanguageOptions,
      plugins: {
        ...guard.configs.recommended.plugins,
        "@typescript-eslint": tseslint,
      },
      settings: guard.configs.recommended.settings,
      rules: sourceRules,
    },
    eslintDisableCommentRules,
  ];
}
