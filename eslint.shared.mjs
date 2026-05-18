import guard from "eslint-plugin-agent-code-guard";
import tsParser from "@typescript-eslint/parser";
import comments from "@eslint-community/eslint-plugin-eslint-comments";

const tsLanguageOptions = {
  parser: tsParser,
  globals: {
    AbortController: "readonly",
    AbortSignal: "readonly",
    Buffer: "readonly",
    Response: "readonly",
    TextDecoder: "readonly",
    TextEncoder: "readonly",
    URL: "readonly",
    clearInterval: "readonly",
    clearTimeout: "readonly",
    console: "readonly",
    crypto: "readonly",
    fetch: "readonly",
    process: "readonly",
    setInterval: "readonly",
    setTimeout: "readonly",
  },
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
};

const packageIgnores = {
  ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"],
};

const makeStrictRules = ({ maxLines = 1050 } = {}) => ({
  ...guard.configs.strict.rules,
  "max-lines": [
    "error",
    { max: maxLines, skipBlankLines: true, skipComments: true },
  ],
});

const makeTestSupportRules = (strictRules) => ({
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
  languageOptions: tsLanguageOptions,
  plugins: guard.configs.strict.plugins,
  settings: guard.configs.strict.settings,
  rules: strictRules,
});

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

const documentationRules = {
  files: ["src/**/index.ts"],
  languageOptions: tsLanguageOptions,
  plugins: guard.configs.documentation.plugins,
  rules: guard.configs.documentation.rules,
};

export function packageEslintConfig(options = {}) {
  const strictRules = makeStrictRules(options);
  return [
    packageIgnores,
    {
      files: ["src/**/*.ts", "*.ts"],
      ignores: ["**/*.test.ts", "**/*.spec.ts"],
      languageOptions: tsLanguageOptions,
      plugins: guard.configs.strict.plugins,
      settings: guard.configs.strict.settings,
      rules: strictRules,
    },
    makeTestSupportRules(strictRules),
    integrationTestRules,
    documentationRules,
    eslintDisableCommentRules,
  ];
}

export function rootEslintConfig() {
  const strictRules = makeStrictRules();
  return [
    packageIgnores,
    {
      files: ["scripts/**/*.ts", "*.ts"],
      languageOptions: tsLanguageOptions,
      plugins: guard.configs.strict.plugins,
      settings: guard.configs.strict.settings,
      rules: strictRules,
    },
    eslintDisableCommentRules,
  ];
}
