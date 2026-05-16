import guard from "eslint-plugin-agent-code-guard";
import tsParser from "@typescript-eslint/parser";
import comments from "@eslint-community/eslint-plugin-eslint-comments";
import tseslint from "@typescript-eslint/eslint-plugin";

const tsLanguageOptions = {
  parser: tsParser,
  globals: {
    AbortController: "readonly",
    AbortSignal: "readonly",
    Buffer: "readonly",
    BufferEncoding: "readonly",
    NodeJS: "readonly",
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

const architectureRuleNames = new Set(
  Object.keys(guard.configs.architecture.rules),
);

const isOffRule = (rule) => (Array.isArray(rule) ? rule[0] : rule) === "off";

const asErrorRule = (rule) =>
  Array.isArray(rule) ? ["error", ...rule.slice(1)] : "error";

const recommendedSourceRules = Object.fromEntries(
  Object.entries(guard.configs.recommended.rules)
    .filter(
      ([ruleName, rule]) =>
        !architectureRuleNames.has(ruleName) && !isOffRule(rule),
    )
    .map(([ruleName, rule]) => [ruleName, asErrorRule(rule)]),
);

const sonarCorrectnessRules = {
  "sonarjs/arguments-usage": "error",
  "sonarjs/array-constructor": "error",
  "sonarjs/aws-iam-all-resources-accessible": "error",
  "sonarjs/aws-s3-bucket-server-encryption": "error",
  "sonarjs/bool-param-default": "error",
  "sonarjs/certificate-transparency": "error",
  "sonarjs/class-prototype": "error",
  "sonarjs/conditional-indentation": "error",
  "sonarjs/cookies": "error",
  "sonarjs/destructuring-assignment-syntax": "error",
  "sonarjs/dns-prefetching": "error",
  "sonarjs/file-name-differ-from-class": "error",
  "sonarjs/for-in": "error",
  "sonarjs/no-built-in-override": "error",
  "sonarjs/no-collapsible-if": "error",
  "sonarjs/no-for-in-iterable": "error",
  "sonarjs/no-function-declaration-in-block": "error",
  "sonarjs/no-incorrect-string-concat": "error",
  "sonarjs/no-nested-incdec": "error",
  "sonarjs/no-nested-switch": "error",
  "sonarjs/no-redundant-parentheses": "error",
  "sonarjs/no-reference-error": "error",
  "sonarjs/no-require-or-define": "error",
  "sonarjs/no-return-type-any": "error",
  "sonarjs/no-sonar-comments": "error",
  "sonarjs/no-tab": "error",
  "sonarjs/no-undefined-assignment": "error",
  "sonarjs/no-unsafe-unzip": "error",
  "sonarjs/no-unused-function-argument": "error",
  "sonarjs/no-variable-usage-before-declaration": "error",
  "sonarjs/no-vue-bypass-sanitization": "error",
  "sonarjs/non-number-in-arithmetic-expression": "error",
  "sonarjs/operation-returning-nan": "error",
  "sonarjs/prefer-immediate-return": "error",
  "sonarjs/prefer-object-literal": "error",
  "sonarjs/standard-input": "error",
  "sonarjs/strings-comparison": "error",
  "sonarjs/unicode-aware-regex": "error",
  "sonarjs/useless-string-operation": "error",
  "sonarjs/values-not-convertible-to-numbers": "error",
  "sonarjs/web-sql-database": "error",
  "sonarjs/xpath": "error",
};

const baseMagicNumberOptions = {
  ignoreArrayIndexes: true,
  ignoreReadonlyClassProperties: true,
};

const noMagicNumbersRule = [
  "error",
  {
    ...baseMagicNumberOptions,
    ignore: [-1, 0, 1],
  },
];

const testNoMagicNumbersRule = [
  "error",
  {
    ...baseMagicNumberOptions,
    ignore: [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
];

const sourceRules = {
  ...recommendedSourceRules,
  ...sonarCorrectnessRules,
  "@typescript-eslint/no-magic-numbers": noMagicNumbersRule,
  "@typescript-eslint/no-unused-vars": "error",
  "sonarjs/no-duplicate-string": ["error", { threshold: 4 }],
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
  plugins: {
    ...guard.configs.recommended.plugins,
    "@typescript-eslint": tseslint,
  },
  rules: {
    "@typescript-eslint/no-magic-numbers": testNoMagicNumbersRule,
    "sonarjs/no-nested-functions": ["error", { threshold: 5 }],
  },
};

export const architecturePlugins = guard.configs.architecture.plugins;

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
