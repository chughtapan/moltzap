// Package ESLint configs load this shared module, so the root owns its plugins.
import { plugin as guard } from "eslint-plugin-agent-code-guard";
import comments from "@eslint-community/eslint-plugin-eslint-comments";

const makeTsLanguageOptions = (tsconfigRootDir, project) => ({
  ...guard.configs.strict.languageOptions,
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
  parserOptions: {
    project,
    tsconfigRootDir,
  },
});

const packageIgnores = {
  ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"],
};

// Effect.gen abandons its generator when a yielded effect fails, so a
// `finally` block cannot provide reliable cleanup on that path. This rule
// flags try/finally inside Effect-driven generators while leaving plain
// generators alone, where iteration runs finally through `.return()`.
// Effect.ensuring and Effect.acquireRelease preserve cleanup on every path.
const genFinallyRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow try/finally inside Effect-driven generator bodies; use Effect.ensuring",
    },
    schema: [],
    messages: {
      genFinally:
        "try/finally inside Effect.gen — no finally code runs when a yielded effect fails; use Effect.ensuring",
    },
  },
  create(context) {
    const functionStack = [];
    const isEffectMember = (node, name) =>
      node.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      node.object.name === "Effect" &&
      node.property.type === "Identifier" &&
      node.property.name === name;
    const isEffectDrivenGenerator = (fn) => {
      if (!fn.generator) return false;
      const call = fn.parent;
      if (call?.type !== "CallExpression" || !call.arguments.includes(fn)) {
        return false;
      }
      return (
        isEffectMember(call.callee, "gen") ||
        (call.callee.type === "CallExpression" &&
          isEffectMember(call.callee.callee, "fn"))
      );
    };
    const enter = (node) => functionStack.push(node);
    const exit = () => functionStack.pop();
    return {
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      TryStatement(node) {
        if (node.finalizer === null) return;
        const fn = functionStack[functionStack.length - 1];
        if (fn !== undefined && isEffectDrivenGenerator(fn)) {
          context.report({ node, messageId: "genFinally" });
        }
      },
    };
  },
};

const localGuardPlugin = { rules: { "gen-finally": genFinallyRule } };

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
  "agent-code-guard/no-vacuous-jsdoc": "error",
  "agent-code-guard/prefer-stepdown-function-order": "error",
  "agent-code-guard/require-stable-file-shell": "error",
  // The architecture analyzer owns deterministic file, folder, domain, and
  // workspace-package cycle detection in one cached whole-project pass.
  "import-x/no-cycle": "off",
  // The TypeScript-aware rule reports the same deprecated-symbol uses without
  // repeating Sonar's expensive type walk for every file.
  "sonarjs/deprecation": "off",
  "@typescript-eslint/naming-convention": [
    "error",
    {
      selector: ["classProperty", "objectLiteralProperty", "typeProperty"],
      modifiers: ["requiresQuotes"],
      format: null,
    },
    ...guard.configs.strict.rules["@typescript-eslint/naming-convention"].slice(
      1,
    ),
  ],
  "@typescript-eslint/no-invalid-void-type": [
    "error",
    {
      allowAsThisParameter: false,
      allowInGenericTypeArguments: [
        "Deferred.Deferred",
        "Effect.Effect",
        "Either.Either",
        "Exit.Exit",
        "Fiber.RuntimeFiber",
      ],
    },
  ],
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
  // Effect and Option constructors intentionally return distinct closed variants
  // through one declared union. SonarJS treats those variants as inconsistent
  // return types even when TypeScript proves the public return type.
  "sonarjs/function-return-type": "off",
  // TypeScript's control-flow analysis owns these checks. SonarJS loses the
  // established narrowing for Effect Schema unions and generic array methods,
  // so it reports errors for statically typed object and string operands.
  "sonarjs/in-operator-type-error": "off",
  "sonarjs/argument-type": "off",
  "local-guard/gen-finally": "error",
});

const makeTestSupportRules = (strictRules, languageOptions) => ({
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
  languageOptions,
  plugins: { ...guard.configs.strict.plugins, "local-guard": localGuardPlugin },
  settings: guard.configs.strict.settings,
  rules: strictRules,
});

const makeEslintDisableCommentRules = (languageOptions) => ({
  files: ["**/*.ts", "**/*.cts", "**/*.mts"],
  languageOptions,
  plugins: { "eslint-comments": comments },
  rules: {
    "eslint-comments/require-description": ["error", { ignore: [] }],
  },
});

const makeIntegrationTestRules = (languageOptions) => ({
  files: ["src/**/*.integration.test.ts"],
  languageOptions,
  plugins: guard.configs.integrationTests.plugins,
  rules: guard.configs.integrationTests.rules,
});

const makeDocumentationRules = (languageOptions) => ({
  files: ["src/**/index.ts"],
  languageOptions,
  plugins: guard.configs.documentation.plugins,
  rules: guard.configs.documentation.rules,
});

// `@failure` is the project-wide convention for Effect error-channel
// documentation, registered here rather than in prose. Every package gets it for
// free; pass `customJsDocTags` to extend the list per package.
const DEFAULT_CUSTOM_JSDOC_TAGS = ["failure"];

export function packageEslintConfig(options = {}) {
  const strictRules = makeStrictRules(options);
  const languageOptions = makeTsLanguageOptions(
    options.tsconfigRootDir,
    options.projects ?? ["./tsconfig.json", "./tsconfig.test.json"],
  );
  const customTags = [
    ...DEFAULT_CUSTOM_JSDOC_TAGS,
    ...(options.customJsDocTags ?? []),
  ];
  const tagRules = {
    "jsdoc/check-tag-names": ["error", { definedTags: customTags }],
  };
  return [
    packageIgnores,
    {
      files: [
        "src/**/*.ts",
        "src/**/*.cts",
        "src/**/*.mts",
        "scripts/**/*.ts",
        "scripts/**/*.cts",
        "scripts/**/*.mts",
        "*.ts",
        "*.cts",
        "*.mts",
      ],
      ignores: ["**/*.test.ts", "**/*.spec.ts"],
      languageOptions,
      plugins: {
        ...guard.configs.strict.plugins,
        "local-guard": localGuardPlugin,
      },
      settings: guard.configs.strict.settings,
      rules: { ...strictRules, ...tagRules },
    },
    makeTestSupportRules(strictRules, languageOptions),
    makeIntegrationTestRules(languageOptions),
    makeDocumentationRules(languageOptions),
    makeEslintDisableCommentRules(languageOptions),
  ];
}

export function rootEslintConfig(options = {}) {
  const strictRules = makeStrictRules();
  const languageOptions = makeTsLanguageOptions(
    options.tsconfigRootDir,
    "./tsconfig.eslint.json",
  );
  return [
    {
      ignores: [
        ".claude/**",
        ".repos/**",
        "packages/**",
        "scripts/**",
        "v2/**",
      ],
    },
    packageIgnores,
    {
      files: ["*.ts", "examples/**/*.ts"],
      languageOptions,
      plugins: {
        ...guard.configs.strict.plugins,
        "local-guard": localGuardPlugin,
      },
      settings: guard.configs.strict.settings,
      rules: strictRules,
    },
    makeEslintDisableCommentRules(languageOptions),
  ];
}
