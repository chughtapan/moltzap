#!/usr/bin/env node
/**
 * @file Gate + generator smoke tests. Plain Node, no vitest config —
 * runs the three doc-side scripts under controlled mutations that are
 * restored after each assertion. It proves (1) the gates pass on the clean
 * snapshot, (2) gates flag every planted regression, and (3) the constants
 * generator is idempotent across re-runs.
 *
 * Invoked via `pnpm docs:check:gates-test`.
 *
 * Exit codes:
 *   0 — every assertion passed.
 *   1 — one or more assertions failed; details printed to stderr.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readCompatibilityVersion as readCompatibilityVersionSource,
  WIRE_VERSION_LITERAL,
  WIRE_VERSION_SOURCE,
} from "../docs/sharness-version.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const CONTRIBUTING_DOC = "docs/development/contributing.mdx";

const workspaceRoot = resolve(scriptDir, "..", "..");

interface AssertionFailure {
  readonly name: string;
  readonly message: string;
}

const failures: AssertionFailure[] = [];

// Tests mutate real files under `docs/` to trigger gate hits, then
// restore the original contents in a finally block. The plant stack
// lets a single restoreAllPlants() call rewind in reverse order.
const planted: Array<{
  path: string;
  original: string;
}> = [];

/** Idempotence snapshots run before any generator success case writes outputs, so they compare against the original on-disk bytes. */
function main(): void {
  try {
    testNoHardcodedConstants();
    testDocImportsResolve();
    testGeneratorIdempotence();
    testCompatibilityVersionFile();
    testBakeFailureFailClosed();
    testNodeVersionFloorConsistency();
    testPublicationGuards();
    testMalformedBoundaryInputs();
  } finally {
    restoreAllPlants();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll gate + generator tests passed.");
}

function testNoHardcodedConstants(): void {
  console.log("\n# check-no-hardcoded-constants");
  const clean = runScript(
    "scripts/docs/check-no-hardcoded-constants.ts",
    workspaceRoot,
  );
  test(
    "clean tree exits 0",
    clean.code === 0,
    `expected exit 0, got ${clean.code}. stderr: ${clean.stderr}`,
  );
  if (existsSync(resolve(workspaceRoot, CONTRIBUTING_DOC))) {
    plantFile(
      CONTRIBUTING_DOC,
      (s) => `${s}\nProtocol pinned at 2026.524.1 for this run.\n`,
    );
    const r1 = runScript(
      "scripts/docs/check-no-hardcoded-constants.ts",
      workspaceRoot,
    );
    test(
      "flags planted version-shaped literal",
      r1.code !== 0 && /VERSION_SHAPED_LITERAL/.test(r1.stderr),
      `expected VERSION_SHAPED_LITERAL hit. exit=${r1.code}, stderr=${r1.stderr.slice(0, 300)}`,
    );
    restoreAllPlants();
  } else {
    test(
      "planted-regression target exists",
      false,
      `${CONTRIBUTING_DOC} not found`,
    );
  }
  testBakedVersionDrift();
}

function testDocImportsResolve(): void {
  testDocImportsResolveClean();
  testDocImportsResolveR2();
  testDocImportsResolveR4();
  testDocImportsResolveR5();
  testDocImportsResolveR6();
  testDocImportsResolveR7();
  testDocImportsResolveR8();
  testDocImportsResolveR9();
}

function testDocImportsResolveClean(): void {
  console.log("\n# check-doc-imports-resolve");
  const clean = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  test(
    "clean tree exits 0",
    clean.code === 0,
    `expected exit 0, got ${clean.code}. stderr: ${clean.stderr}`,
  );
  plantFile(
    CONTRIBUTING_DOC,
    (s) =>
      `${s}\n\`\`\`typescript\nimport { foo } from "@moltzap/identity/does-not-exist";\n\`\`\`\n`,
  );
  const r1 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  test(
    "flags unknown subpath",
    r1.code !== 0 && /unknown-subpath/.test(r1.stderr),
    `expected unknown-subpath. exit=${r1.code}, stderr=${r1.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testDocImportsResolveR2(): void {
  plantFile(
    CONTRIBUTING_DOC,
    (s) =>
      `${s}\n\`\`\`typescript\nimport { ThisSymbolDoesNotExist } from "@moltzap/identity";\n\`\`\`\n`,
  );
  const r2 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  test(
    "flags missing named export",
    r2.code !== 0 && /missing-export/.test(r2.stderr),
    `expected missing-export. exit=${r2.code}, stderr=${r2.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

/** Unknown names in multiline imports must reach the binding validator rather than disappear during folding. */
function testDocImportsResolveR4(): void {
  plantFile(
    CONTRIBUTING_DOC,
    (s) =>
      `${s}\n\`\`\`typescript\nimport {\n  ThisSymbolDoesNotExist,\n  AlsoNotExported,\n} from "@moltzap/identity";\n\`\`\`\n`,
  );
  const r4 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  test(
    "multi-line import with unknown binding flagged as missing-export (joinMultiLineImports regression)",
    r4.code !== 0 &&
      /missing-export/.test(r4.stderr) &&
      /ThisSymbolDoesNotExist/.test(r4.stderr),
    `expected missing-export from folded multi-line import. exit=${r4.code}, stderr=${r4.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

/** Valid multiline bindings guard against false positives introduced by import folding. */
function testDocImportsResolveR5(): void {
  plantFile(
    CONTRIBUTING_DOC,
    (s) =>
      `${s}\n\`\`\`typescript\nimport {\n  AgentId,\n  AgentName,\n} from "@moltzap/identity";\n\`\`\`\n`,
  );
  const r5 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  test(
    "multi-line import with valid bindings still passes (joinMultiLineImports positive)",
    r5.code === 0,
    `expected clean pass, got exit=${r5.code}, stderr=${r5.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testDocImportsResolveR6(): void {
  plantFile(
    CONTRIBUTING_DOC,
    (s) =>
      `${s}\n\`\`\`typescript\nimport { WIRE_VERSION } from "@moltzap/identity";\nimport { Registry } from "@moltzap/identity/registry";\nimport "@moltzap/identity/registry/server";\nimport "@moltzap/router/server";\n\`\`\`\n`,
  );
  const r6 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  test(
    "final identity and router package subpaths resolve",
    r6.code === 0,
    `expected final package imports to pass. exit=${r6.code}, stderr=${r6.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testDocImportsResolveR7(): void {
  plantFile(
    CONTRIBUTING_DOC,
    (s) =>
      `${s}\n\`\`\`typescript\nimport { ThisIdentitySymbolDoesNotExist } from "@moltzap/identity";\n\`\`\`\n`,
  );
  const r7 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  test(
    "flags missing identity named export",
    r7.code !== 0 &&
      /missing-export/.test(r7.stderr) &&
      /ThisIdentitySymbolDoesNotExist/.test(r7.stderr),
    `expected identity missing-export. exit=${r7.code}, stderr=${r7.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testDocImportsResolveR8(): void {
  plantFile(
    CONTRIBUTING_DOC,
    (s) =>
      `${s}\n\`\`\`typescript\nimport "@moltzap/router/does-not-exist";\n\`\`\`\n`,
  );
  const r8 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  test(
    "flags unknown router subpath",
    r8.code !== 0 && /unknown-subpath/.test(r8.stderr),
    `expected router unknown-subpath. exit=${r8.code}, stderr=${r8.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testDocImportsResolveR9(): void {
  plantFile("packages/router/package.json", (s) =>
    s.replace("./dist/server.js", "./dist/missing-server.js"),
  );
  plantFile(
    CONTRIBUTING_DOC,
    (s) => `${s}\n\`\`\`typescript\nimport "@moltzap/router/server";\n\`\`\`\n`,
  );
  const r9 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  test(
    "flags a documented router subpath with no source or built target",
    r9.code !== 0 && /missing-target/.test(r9.stderr),
    `expected router missing-target. exit=${r9.code}, stderr=${r9.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testBakeFailureFailClosed(): void {
  console.log("\n# generate-constants-snippets bake-failure fail-closed");
  const clean = runGenerate(workspaceRoot);
  test(
    "clean tree: generator exits 0",
    clean.code === 0,
    `expected exit 0, got ${clean.code}. stderr: ${clean.stderr.slice(0, 300)}`,
  );
  const target = "docs/spec/identity.md";
  plantFile(target, (s) =>
    s.replace(
      // eslint-disable-next-line sonarjs/slow-regex -- The input is bounded, repository-owned documentation or a fixed test fixture.
      /\{\/\*\s*@bake-constants:\s*([^*]+?)\s*\*\/\}/,
      "{/* @bake-constants: $1 NOT_A_REAL_CONSTANT */}",
    ),
  );
  const r = runGenerate(workspaceRoot);
  test(
    "unknown constant in bake marker triggers non-zero exit",
    r.code !== 0,
    `expected non-zero exit on unknown bake constant. exit=${r.code}, stderr=${r.stderr.slice(0, 300)}`,
  );
  test(
    "bake-failure stderr names the unknown constant",
    /NOT_A_REAL_CONSTANT/.test(r.stderr) &&
      /marker lists unknown constant/.test(r.stderr),
    `expected NOT_A_REAL_CONSTANT + 'unknown constant' in stderr. stderr=${r.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testCompatibilityVersionFile(): void {
  console.log("\n# MoltZap compatibility version source");
  plantFile(WIRE_VERSION_SOURCE, withCompatibilityVersion(""));
  const empty = runGenerate(workspaceRoot);
  test(
    "empty MoltZap version fails closed",
    empty.code !== 0 && /expected a nonempty version/.test(empty.stderr),
    `expected empty-version failure. exit=${empty.code}, stderr=${empty.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
  const currentVersion = readCompatibilityVersion();
  const nextVersion = "2099.999.8";
  const marker = "@bake-constants: V2_PROTOCOL_VERSION";
  const consumers = [
    ...walkFiles(resolve(workspaceRoot, "docs")),
    resolve(workspaceRoot, "README.md"),
  ]
    .filter((path) => /\.mdx?$/.test(path))
    .filter((path) => readFileSync(path, "utf8").includes(marker));
  for (const path of consumers) {
    test(
      `compatibility marker has current value: ${path.split("/").slice(-2).join("/")}`,
      readFileSync(path, "utf8").includes(currentVersion),
      `${path} has a V2 bake marker but not ${currentVersion}`,
    );
  }
  const generated = [
    "docs/snippets/constants/values.json",
    "docs/snippets/constants/values.mdx",
  ];
  for (const path of [
    ...consumers,
    ...generated.map((p) => resolve(workspaceRoot, p)),
  ]) {
    const original = readFileSync(path, "utf8");
    planted.push({ path, original });
  }
  plantFile(WIRE_VERSION_SOURCE, withCompatibilityVersion(nextVersion));
  const bumped = runGenerate(workspaceRoot);
  test(
    "changed MoltZap version regenerates constants",
    bumped.code === 0,
    `expected successful regeneration. exit=${bumped.code}, stderr=${bumped.stderr.slice(0, 300)}`,
  );
  checkRegeneratedVersion(consumers, generated, nextVersion);
  restoreAllPlants();
}

function testPublicationGuards(): void {
  testPublicationGuardsClean();
  testPublicationGuardsPublicNanoClaw();
  testPublicationGuardsPrivateIdentity();
  testPublicationGuardsWrongLicense();
  testPublicationGuardsDriftedNotice();
  testPublicationGuardsForeignRepository();
  testPublicationGuardsDriftedEngines();
  testPublicationGuardsSemver();
  testPublicationGuardsWireSemver();
  testPublicationGuardsDriftedList();
  testPublicationGuardsTestOnly();
}

/** Test overrides require an explicit condition and cannot enter production source. */
function testPublicationGuardsTestOnly(): void {
  plantFile("packages/identity/package.json", (source) =>
    source.replace('"sharness-test": {', '"default": {'),
  );
  const unconditional = runBoundaries();
  test(
    "rejects a test override exposed to production resolution",
    unconditional.code !== 0 &&
      /test-only export.*conditions drifted/.test(unconditional.stderr),
    `expected conditional-export failure. exit=${unconditional.code}, stderr=${unconditional.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
  plantFile(
    "packages/client/src/transport/messaging/index.ts",
    (source) =>
      'import { WireVersions } from "@moltzap/identity/test";\n' + source,
  );
  const production = runBoundaries();
  test(
    "rejects a production import of the test override",
    production.code !== 0 &&
      /production source must not import test-only export/.test(
        production.stderr,
      ),
    `expected production-import failure. exit=${production.code}, stderr=${production.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsClean(): void {
  console.log("\n# check-boundaries publication guards");
  const clean = runBoundaries();
  test(
    "clean tree passes the publication guards",
    clean.code === 0,
    `expected exit 0, got ${clean.code}. stderr: ${clean.stderr.slice(0, 300)}`,
  );
  plantFile("packages/openclaw-channel/package.json", (s) =>
    s.replace(/"version": "[^"]+"/, '"version": "2026.101.0"'),
  );
  const unequal = runBoundaries();
  test(
    "flags a published manifest whose version differs from its siblings",
    unequal.code !== 0 && /must share one version/.test(unequal.stderr),
    `expected one-version failure. exit=${unequal.code}, stderr=${unequal.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsPublicNanoClaw(): void {
  plantFile("packages/nanoclaw-channel/package.json", (s) =>
    // eslint-disable-next-line sonarjs/slow-regex -- The input is bounded, repository-owned documentation or a fixed test fixture.
    s.replace(/\s*"private": true,/, ""),
  );
  const publicNanoClaw = runBoundaries();
  test(
    "flags NanoClaw losing its private flag",
    publicNanoClaw.code !== 0 &&
      /nanoclaw-channel\/package\.json: must stay private/.test(
        publicNanoClaw.stderr,
      ),
    `expected NanoClaw-private failure. exit=${publicNanoClaw.code}, stderr=${publicNanoClaw.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsPrivateIdentity(): void {
  plantFile("packages/identity/package.json", (s) =>
    s.replace('"version"', '"private": true,\n  "version"'),
  );
  const privateIdentity = runBoundaries();
  test(
    "flags a published package that carries private",
    privateIdentity.code !== 0 &&
      /identity\/package\.json: a published package must not carry "private"/.test(
        privateIdentity.stderr,
      ),
    `expected published-private failure. exit=${privateIdentity.code}, stderr=${privateIdentity.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsWrongLicense(): void {
  plantFile("packages/router/package.json", (s) =>
    s.replace('"license": "Apache-2.0"', '"license": "MIT"'),
  );
  const wrongLicense = runBoundaries();
  test(
    "flags a published package with another license",
    wrongLicense.code !== 0 &&
      /router\/package\.json: license is "MIT"/.test(wrongLicense.stderr),
    `expected license failure. exit=${wrongLicense.code}, stderr=${wrongLicense.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsDriftedNotice(): void {
  plantFile("packages/router/NOTICE", (s) => `${s}Extra line.\n`);
  const driftedNotice = runBoundaries();
  test(
    "flags a packaged NOTICE that differs from the repository NOTICE",
    driftedNotice.code !== 0 &&
      /router\/NOTICE: must be an identical copy/.test(driftedNotice.stderr),
    `expected NOTICE drift failure. exit=${driftedNotice.code}, stderr=${driftedNotice.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsForeignRepository(): void {
  plantFile("packages/router/package.json", (s) =>
    s.replace(
      "git+https://github.com/chughtapan/moltzap.git",
      "https://example.invalid/fork.git",
    ),
  );
  const foreignRepository = runBoundaries();
  test(
    "flags a published package pointing at another repository",
    foreignRepository.code !== 0 &&
      /router\/package\.json: repository\.url must be/.test(
        foreignRepository.stderr,
      ),
    `expected repository failure. exit=${foreignRepository.code}, stderr=${foreignRepository.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsDriftedEngines(): void {
  plantFile("packages/router/package.json", (s) =>
    s.replace(/"node": "[^"]+"/, '"node": ">=20"'),
  );
  const driftedEngines = runBoundaries();
  test(
    "flags a published Node.js range that differs from the workspace root",
    driftedEngines.code !== 0 &&
      /router\/package\.json: engines\.node is ">=20", expected the root/.test(
        driftedEngines.stderr,
      ),
    `expected engines failure. exit=${driftedEngines.code}, stderr=${driftedEngines.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsSemver(): void {
  plantFile("packages/router/package.json", (s) =>
    s.replace(/"version": "[^"]+"/, '"version": "1.2.3"'),
  );
  const semver = runBoundaries();
  test(
    "flags a published manifest whose version is not a calendar version",
    semver.code !== 0 &&
      /router\/package\.json: version "1\.2\.3" is not a YYYY\.MDD\.N CalVer/.test(
        semver.stderr,
      ),
    `expected calver failure. exit=${semver.code}, stderr=${semver.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsWireSemver(): void {
  plantFile(WIRE_VERSION_SOURCE, withCompatibilityVersion("1.2.3"));
  const wireSemver = runBoundaries();
  test(
    "flags a wire compatibility literal that is not a calendar version",
    wireSemver.code !== 0 &&
      /WIRE_VERSION "1\.2\.3" is not a YYYY\.MDD\.N CalVer/.test(
        wireSemver.stderr,
      ),
    `expected wire-literal failure. exit=${wireSemver.code}, stderr=${wireSemver.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function testPublicationGuardsDriftedList(): void {
  plantFile(".github/workflows/publish.yml", (s) =>
    // eslint-disable-next-line sonarjs/slow-regex -- The input is bounded, repository-owned documentation or a fixed test fixture.
    s.replace(/^(\s*RELEASE_PACKAGES:\s*).+$/m, "$1identity router"),
  );
  const driftedList = runBoundaries();
  test(
    "flags a release package list that drifted from the published set",
    driftedList.code !== 0 &&
      /RELEASE_PACKAGES drifted from the published set/.test(
        driftedList.stderr,
      ),
    `expected release-list failure. exit=${driftedList.code}, stderr=${driftedList.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

const MALFORMED_BOUNDARY_CASES = [
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
  { path: "packages/identity/tsconfig.json", before: "", after: "" },
] as const;

/** Malformed additions must fail even when every valid entry remains present. */
function testMalformedBoundaryInputs(): void {
  console.log("\n# check-boundaries malformed inputs");
  for (const [index, input] of MALFORMED_BOUNDARY_CASES.entries()) {
    try {
      plantFile(input.path, (source) => {
        if (input.before === "") {
          return "[]";
        }
        if (!source.includes(input.before)) {
          throw new Error(`Mutation target missing in ${input.path}`);
        }
        return source.replace(input.before, input.after);
      });
      const malformed = runBoundaries();
      test(
        `rejects malformed boundary input ${index + 1}: ${input.path}`,
        malformed.code === 1 && /Malformed/.test(malformed.stderr),
        `expected malformed-input failure. exit=${malformed.code}, stderr=${malformed.stderr.slice(0, 300)}`,
      );
    } finally {
      restoreAllPlants();
    }
  }
}

function runBoundaries(): {
  code: number;
  stderr: string;
} {
  return runNode([
    resolve(workspaceRoot, "scripts/architecture/check-boundaries.ts"),
  ]);
}

function withCompatibilityVersion(next: string) {
  return (source: string): string =>
    source.replace(
      WIRE_VERSION_LITERAL,
      `export const WIRE_VERSION = "${next}"`,
    );
}

function testNodeVersionFloorConsistency(): void {
  console.log("\n# Node version floor consistency");
  const workspaceManifest =
    /* Safe because Repository-owned manifest supplies the documented runtime range. */ JSON.parse(
      readFileSync(resolve(workspaceRoot, "package.json"), "utf8"),
    ) as {
      readonly engines?: {
        readonly node?: string;
      };
    };
  const pinnedNode = readFileSync(
    resolve(workspaceRoot, ".node-version"),
    "utf8",
  ).trim();
  const pinnedMajor = Number(pinnedNode.split(".")[0]);
  const quickstartDocs = readFileSync(
    resolve(workspaceRoot, "docs/quickstart.mdx"),
    "utf8",
  );
  const workspaceNodeRange = workspaceManifest.engines?.node;
  test(
    "workspace and pinned runtime support Node.js 22+",
    workspaceNodeRange?.startsWith(">=22.") === true &&
      pinnedMajor >= 22 &&
      pinnedMajor < 25,
    `expected a pinned Node.js 22–24 runtime, got engines.node=${String(workspaceNodeRange)} and .node-version=${pinnedNode}`,
  );
  test(
    "quickstart matches the workspace Node.js range",
    quickstartDocs.includes(`Node.js \`${String(workspaceNodeRange)}\``),
    `quickstart does not advertise Node.js \`${String(workspaceNodeRange)}\``,
  );
}

function testGeneratorIdempotence(): void {
  console.log("\n# generate-constants-snippets idempotence");
  const valuesJsonPath = resolve(
    workspaceRoot,
    "docs/snippets/constants/values.json",
  );
  const valuesMdxPath = resolve(
    workspaceRoot,
    "docs/snippets/constants/values.mdx",
  );
  const beforeJson = readFileSync(valuesJsonPath, "utf8");
  const beforeMdx = readFileSync(valuesMdxPath, "utf8");
  const bakedFiles = [
    ...walkFiles(resolve(workspaceRoot, "docs")),
    resolve(workspaceRoot, "README.md"),
  ]
    .filter((path) => /\.mdx?$/.test(path))
    .filter((path) => readFileSync(path, "utf8").includes("@bake-constants:"))
    .sort((left, right) => (left < right ? -1 : Number(left > right)));
  const before = bakedFiles.map((p) => readFileSync(p, "utf8"));
  const r = runGenerate(workspaceRoot);
  test(
    "generator runs to completion",
    r.code === 0,
    `generator exit ${r.code}: ${r.stderr.slice(0, 300)}`,
  );
  test(
    "values.json unchanged after re-generate",
    readFileSync(valuesJsonPath, "utf8") === beforeJson,
    "values.json contents drifted across re-runs",
  );
  test(
    "values.mdx unchanged after re-generate",
    readFileSync(valuesMdxPath, "utf8") === beforeMdx,
    "values.mdx contents drifted across re-runs",
  );
  for (let i = 0; i < bakedFiles.length; i++) {
    const after = readFileSync(bakedFiles[i] ?? "", "utf8");
    test(
      `baked file unchanged: ${bakedFiles[i]?.split("/").slice(-2).join("/")}`,
      after === before[i],
      `${bakedFiles[i]} drifted across re-runs`,
    );
  }
}

function runGenerate(cwd: string): {
  code: number;
  stdout: string;
  stderr: string;
} {
  return runScript("scripts/docs/generate-constants-snippets.ts", cwd);
}

function walkFiles(root: string): readonly string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = resolve(root, name);
    if (statSync(path).isDirectory()) {
      out.push(...walkFiles(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

function testBakedVersionDrift(): void {
  const compatibilityVersion = readCompatibilityVersion();
  plantFile(
    CONTRIBUTING_DOC,
    (s) =>
      `${s}\nMoltZap compatibility pinned at ${compatibilityVersion} for this run.\n`,
  );
  const r2 = runScript(
    "scripts/docs/check-no-hardcoded-constants.ts",
    workspaceRoot,
  );
  test(
    "flags planted V2_PROTOCOL_VERSION literal",
    r2.code !== 0 && /V2_PROTOCOL_VERSION/.test(r2.stderr),
    `expected V2_PROTOCOL_VERSION hit. exit=${r2.code}, stderr=${r2.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
  const compatibilityBakedTarget = "docs/spec/router-representation.md";
  plantFile(compatibilityBakedTarget, (s) =>
    s.replace(compatibilityVersion, `${compatibilityVersion}0`),
  );
  const r3 = runScript(
    "scripts/docs/check-no-hardcoded-constants.ts",
    workspaceRoot,
  );
  test(
    "flags prefix-extending version drift inside a V2-baked document",
    r3.code !== 0 && /VERSION_SHAPED_LITERAL/.test(r3.stderr),
    `expected VERSION_SHAPED_LITERAL hit. exit=${r3.code}, stderr=${r3.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
}

function runScript(
  script: string,
  cwd: string,
): {
  code: number;
  stdout: string;
  stderr: string;
} {
  return runNode([script], cwd);
}

function runNode(
  args: readonly string[],
  cwd = workspaceRoot,
): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(process.execPath, [...args], {
    cwd,
    encoding: "utf8",
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function readCompatibilityVersion(): string {
  const read = readCompatibilityVersionSource(workspaceRoot);
  if ("error" in read) {
    throw new Error(read.error);
  }
  return read.value;
}

function plantFile(relPath: string, mutate: (s: string) => string): void {
  const abs = resolve(workspaceRoot, relPath);
  const original = readFileSync(abs, "utf8");
  planted.push({ path: abs, original });
  writeFileSync(abs, mutate(original));
}

function restoreAllPlants(): void {
  while (planted.length > 0) {
    const p = planted.pop();
    if (p === undefined) {
      break;
    }
    writeFileSync(p.path, p.original);
  }
}

function checkRegeneratedVersion(
  consumers: readonly string[],
  generated: readonly string[],
  nextVersion: string,
): void {
  for (const path of consumers) {
    test(
      `re-bakes MoltZap version: ${path.split("/").slice(-2).join("/")}`,
      readFileSync(path, "utf8").includes(nextVersion),
      `${path} did not contain ${nextVersion} after regeneration`,
    );
  }
  for (const path of generated) {
    test(
      `regenerates MoltZap version snippet: ${path.split("/").slice(-2).join("/")}`,
      readFileSync(resolve(workspaceRoot, path), "utf8").includes(nextVersion),
      `${path} did not contain ${nextVersion} after regeneration`,
    );
  }
}

function test(name: string, cond: boolean, message: string): void {
  // eslint-disable-next-line sonarjs/no-selector-parameter -- A boolean assertion selects the success or failure report in this standalone test runner.
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, message });
    console.error(`  ✗ ${name}: ${message}`);
  }
}

main();
