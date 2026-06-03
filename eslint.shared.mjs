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

// The `max-non-trivial-classes-per-file` default exemption list covers
// Effect's own tag-class factories (`Context.Tag`, `Data.TaggedError`, ...) but
// not `@effect/rpc`'s `RpcMiddleware.Tag`, which is the same kind of factory:
// `class X extends RpcMiddleware.Tag<X>()(name, opts) {}` declares a zero-body
// Tag, not a real implementation. The per-method `AuthMiddleware` descriptors
// are one such Tag per method, co-located by design, so the factory is added to
// the exemption list workspace-wide.
const TAG_CLASS_FACTORIES = [
  "Data.TaggedError",
  "Data.TaggedClass",
  "Data.Class",
  "Data.Error",
  "Schema.Class",
  "Schema.TaggedClass",
  "Schema.TaggedError",
  "Schema.TaggedRequest",
  "Context.Tag",
  "Context.Reference",
  "Effect.Service",
  "Effect.Tag",
  "RpcMiddleware.Tag",
];

const makeStrictRules = ({ maxLines = 1050 } = {}) => ({
  ...guard.configs.strict.rules,
  "agent-code-guard/max-non-trivial-classes-per-file": [
    "error",
    { max: 1, factories: TAG_CLASS_FACTORIES },
  ],
  "max-lines": [
    "error",
    { max: maxLines, skipBlankLines: true, skipComments: true },
  ],
  // Disabled: knip runs once at the workspace root (whole-monorepo)
  // via `pnpm lint`; per-package lint scripts run eslint only.
  "agent-code-guard/require-knip-in-lint": "off",
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

// Architecture options consumed by @safer-by-default/architecture-lsp's
// LSP server + `check.js` CLI. The analyzer reads these from
// settings["agent-code-guard"].architecture; see safer-by-default PR #313.
//
// publicTypePackages: vendor packages whose types are intentionally part
// of the public contract — channels and the client SDK expose Effect and
// the moltzap protocol/client types directly. Wrapping them at every
// boundary would produce noise without changing the actual contract.
//
// allowedTestPublicSubpaths: package.json `exports` keys that intentionally
// expose test-only paths for cross-package integration testing.
const architectureSettings = {
  "agent-code-guard": {
    architecture: {
      publicTypePackages: [
        {
          package: "effect",
          reason:
            "Foundational Effect runtime; intentionally part of public contract",
        },
        {
          package: "@effect/platform",
          reason: "Effect platform abstractions used at boundaries",
        },
        {
          package: "@effect/platform-node",
          reason: "Effect Node integration used at boundaries",
        },
        {
          package: "@sinclair/typebox",
          reason: "Schema runtime; types are the contract",
        },
        {
          package: "@moltzap/protocol",
          reason: "Intra-monorepo protocol; foundational shared contract",
        },
        {
          package: "@moltzap/client",
          reason:
            "Intra-monorepo client SDK; channels depend on its public surface",
        },
      ],
      allowedTestPublicSubpaths: [
        {
          subpath: "./test-utils",
          reason: "Test helpers exposed for cross-package integration testing",
        },
        {
          subpath: "./test",
          reason: "Test harness API for downstream packages",
        },
        {
          subpath: "./test-support",
          reason: "Channel test support exposed for integration tests",
        },
        {
          subpath: "./testing",
          reason:
            "Conformance + driver surface for cross-package integration testing; consumed by moltzap-arena. The 5 protocol domain subpaths (./transport ./identity ./network ./task ./app) mirror the enforced layer DAG; ./testing is the one sanctioned test-only public subpath.",
        },
      ],
    },
  },
};

// Per-package architecture additions (e.g., `layers`) merge ON TOP of
// the shared architectureSettings. Packages that don't pass `architecture`
// get the shared defaults.
function buildArchitectureSettings(extra) {
  if (extra === undefined) return architectureSettings;
  return {
    "agent-code-guard": {
      architecture: {
        ...architectureSettings["agent-code-guard"].architecture,
        ...extra,
      },
    },
  };
}

// `@failure` is the project-wide convention for Effect error-channel
// documentation (see workspace CLAUDE.md). Every package gets it for
// free; pass `customJsDocTags` to extend the list per package.
const DEFAULT_CUSTOM_JSDOC_TAGS = ["failure"];

export function packageEslintConfig(options = {}) {
  const strictRules = makeStrictRules(options);
  const customTags = [
    ...DEFAULT_CUSTOM_JSDOC_TAGS,
    ...(options.customJsDocTags ?? []),
  ];
  const tagRules = {
    "jsdoc/check-tag-names": ["error", { definedTags: customTags }],
  };
  const settings = {
    ...guard.configs.strict.settings,
    ...buildArchitectureSettings(options.architecture),
  };
  return [
    packageIgnores,
    {
      files: ["src/**/*.ts", "scripts/**/*.ts", "*.ts"],
      ignores: ["**/*.test.ts", "**/*.spec.ts"],
      languageOptions: tsLanguageOptions,
      plugins: guard.configs.strict.plugins,
      settings,
      rules: { ...strictRules, ...tagRules },
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
      files: ["*.ts"],
      languageOptions: tsLanguageOptions,
      plugins: guard.configs.strict.plugins,
      settings: { ...guard.configs.strict.settings, ...architectureSettings },
      rules: strictRules,
    },
    eslintDisableCommentRules,
  ];
}
