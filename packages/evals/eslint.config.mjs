import { packageEslintConfig } from "../../eslint.shared.mjs";

export default [
  ...packageEslintConfig(),
  {
    files: ["src/full-runtime.integration.test.ts"],
    rules: {
      // `@effect/vitest` exposes scoped tests as `it.scopedLive`; Sonar only
      // recognizes direct `it(...)` calls and otherwise reports an empty file.
      "sonarjs/no-empty-test-file": "off",
    },
  },
];
