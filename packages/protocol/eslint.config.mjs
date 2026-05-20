import { packageEslintConfig } from "../../eslint.shared.mjs";

export default [
  ...packageEslintConfig({ maxLines: 1200 }),
  {
    // Documentation generators are byte-level scanners and TypeDoc
    // walkers. The strict production-code complexity / nesting /
    // line-length budgets are wrong for this code; relax them here.
    files: ["scripts/**/*.ts"],
    rules: {
      complexity: "off",
      "max-depth": "off",
      "max-lines-per-function": "off",
      "max-nested-callbacks": "off",
      "max-statements": "off",
      "no-nested-ternary": "off",
      "sonarjs/cognitive-complexity": "off",
      "sonarjs/cyclomatic-complexity": "off",
      "sonarjs/expression-complexity": "off",
      "sonarjs/max-lines-per-function": "off",
      "sonarjs/nested-control-flow": "off",
      "sonarjs/no-nested-conditional": "off",
      "sonarjs/no-nested-functions": "off",
      "sonarjs/no-nested-template-literals": "off",
      "sonarjs/too-many-break-or-continue-in-loop": "off",
      "agent-code-guard/either-discriminant": "off",
      "agent-code-guard/no-effect-error-coalescing": "off",
      "agent-code-guard/require-span-on-exported-effect": "off",
      "jsdoc/text-escaping": "off",
    },
  },
];
