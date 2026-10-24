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
    before: '"test:registry-router": {',
    after: '"test:renamed": {',
    message:
      /required Nx target declarations are missing: test:registry-router/,
  },
  {
    name: "integration fixtures cannot import internal Identity",
    path: "tests/integration/daemon-process-harness.ts",
    before: "",
    after: 'import "@moltzap/identity/internal";\n',
    message:
      /test infrastructure must import public or test-only product exports/,
  },
];
