/** @file Mutations that exercise the private integration workspace contract. */

/** Each case identifies a forbidden workspace change and its gate diagnostic. */
export const INTEGRATION_BOUNDARY_CASES = [
  {
    name: "integration workspace stays private",
    path: "tests/integration/package.json",
    before: '"private": true',
    after: '"private": false',
    message: /must name @moltzap\/integration-tests and stay private/,
  },
  {
    name: "integration dependency cannot disappear",
    path: "tests/integration/package.json",
    before: '"@moltzap/client": "workspace:*",',
    after: "",
    message: /test infrastructure dependencies drifted/,
  },
  {
    name: "integration dependency cannot be added",
    path: "tests/integration/package.json",
    before: '"devDependencies": {',
    after: '"devDependencies": {"@moltzap/nanoclaw-channel": "workspace:*",',
    message: /test infrastructure dependencies drifted/,
  },
  {
    name: "integration Knip root cannot be renamed",
    path: "knip.json",
    before: '"tests/integration": {',
    after: '"tests/renamed": {',
    message: /test workspace roots drifted/,
  },
  {
    name: "integration lane must be declared",
    path: "tests/integration/package.json",
    before: '"test:integration": {',
    after: '"test:renamed": {',
    message: /required Nx target declarations are missing: test:integration/,
  },
  {
    name: "integration fixtures cannot import internal Identity",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import "@moltzap/identity/internal";\n',
    message:
      /test infrastructure must import public or test-only product exports/,
  },
  {
    name: "relative product source",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import "../../packages/client/src/index.js";\n',
    message: /test infrastructure must not cross its boundary/,
  },
  {
    name: "internal condition text",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'const forbiddenCondition = "sharness-internal";\n',
    message: /test infrastructure must not enable sharness-internal/,
  },
  {
    name: "unexported deep entry",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import "@moltzap/client/dist/index.js";\n',
    message: /test infrastructure must import public or test-only/,
  },
  {
    name: "undeclared product",
    path: "tests/integration/daemon-process-harness.ts",
    prepend: 'import "@moltzap/nanoclaw-channel";\n',
    message: /test infrastructure must import public or test-only/,
  },
  {
    name: "package integration dependency",
    path: "packages/client/integration/otlp-receiver.ts",
    prepend: 'import "@moltzap/registry";\n',
    message: /dependency DAG violation/,
  },
  {
    name: "package integration test-only entry",
    path: "packages/client/integration/otlp-receiver.ts",
    prepend: 'import { WireVersions } from "@moltzap/identity/test";\n',
    message: /production source must not import test-only export/,
  },
];

/** Invalid shapes must fail closed even when the remaining contract is intact. */
export const MALFORMED_BOUNDARY_CASES = [
  {
    path: "tests/integration/package.json",
    before: '"implicitDependencies": []',
    after: '"implicitDependencies": [7]',
  },
  {
    path: "tsconfig.json",
    before: '"references": [',
    after: '"references": [null,',
  },
  {
    path: "tsconfig.json",
    before: '"references": [',
    after: '"references": [{"path": 7},',
  },
  {
    path: "tsconfig.json",
    before: '"references": [',
    after: '"references": [{},',
  },
  {
    path: "knip.json",
    before: '"@electric-sql/pglite",',
    after: '7, "@electric-sql/pglite",',
  },
  {
    path: "packages/identity/tsconfig.json",
    before: '"references": []',
    after: '"references": {}',
  },
  { path: "packages/identity/tsconfig.json", replace: "[]" },
] as const;
