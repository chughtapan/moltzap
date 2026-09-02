#!/usr/bin/env tsx
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
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOLTZAP_VERSION_LITERAL,
  MOLTZAP_VERSION_SOURCE,
  readMoltzapVersion as readMoltzapVersionSource,
} from "../docs/moltzap-version.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..", "..");

interface AssertionFailure {
  readonly name: string;
  readonly message: string;
}

const failures: AssertionFailure[] = [];

const assert = (name: string, cond: boolean, message: string): void => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, message });
    console.error(`  ✗ ${name}: ${message}`);
  }
};

const runScript = (
  script: string,
  cwd: string,
): { code: number; stdout: string; stderr: string } => {
  const r = spawnSync("pnpm", ["exec", "tsx", script], {
    cwd,
    encoding: "utf8",
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

const runGenerate = (
  cwd: string,
): { code: number; stdout: string; stderr: string } => {
  const r = spawnSync(
    "pnpm",
    ["exec", "tsx", "scripts/docs/generate-constants-snippets.ts"],
    { cwd, encoding: "utf8" },
  );
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

/**
 * Run a workspace script under Node directly, without the package manager,
 * so a failing gate reports its own exit code rather than pnpm's.
 */
const runNode = (
  args: readonly string[],
): { code: number; stdout: string; stderr: string } => {
  const r = spawnSync(process.execPath, [...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

const runGenerateDirect = (): { code: number; stderr: string } =>
  runNode([
    resolve(workspaceRoot, "node_modules/tsx/dist/cli.mjs"),
    resolve(workspaceRoot, "scripts/docs/generate-constants-snippets.ts"),
  ]);

const runBoundaries = (): { code: number; stderr: string } =>
  runNode([resolve(workspaceRoot, "scripts/architecture/check-boundaries.js")]);

// ─── Plant / restore helpers ──────────────────────────────────────────────
//
// Tests mutate real files under `docs/` to trigger gate hits, then
// restore the original contents in a finally block. The plant stack
// lets a single restoreAllPlants() call rewind in reverse order.

const planted: { path: string; original: string }[] = [];

const plantFile = (relPath: string, mutate: (s: string) => string): void => {
  const abs = resolve(workspaceRoot, relPath);
  const original = readFileSync(abs, "utf8");
  planted.push({ path: abs, original });
  writeFileSync(abs, mutate(original));
};

const restoreAllPlants = (): void => {
  while (planted.length > 0) {
    const p = planted.pop();
    if (p === undefined) break;
    writeFileSync(p.path, p.original);
  }
};

const walkFiles = (root: string): readonly string[] => {
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
};

// ─── Tests: check-no-hardcoded-constants ──────────────────────────────────

const testNoHardcodedConstants = (): void => {
  console.log("\n# check-no-hardcoded-constants");
  // Positive case: clean tree passes.
  const clean = runScript(
    "scripts/docs/check-no-hardcoded-constants.ts",
    workspaceRoot,
  );
  assert(
    "clean tree exits 0",
    clean.code === 0,
    `expected exit 0, got ${clean.code}. stderr: ${clean.stderr}`,
  );

  // Planted regression 1: an unowned version-shaped literal in a maintained
  // document.
  const target1 = "docs/development/contributing.mdx";
  if (existsSync(resolve(workspaceRoot, target1))) {
    plantFile(
      target1,
      (s) => `${s}\nProtocol pinned at 2026.524.1 for this run.\n`,
    );
    const r1 = runScript(
      "scripts/docs/check-no-hardcoded-constants.ts",
      workspaceRoot,
    );
    assert(
      "flags planted version-shaped literal",
      r1.code !== 0 && /VERSION_SHAPED_LITERAL/.test(r1.stderr),
      `expected VERSION_SHAPED_LITERAL hit. exit=${r1.code}, stderr=${r1.stderr.slice(0, 300)}`,
    );
    restoreAllPlants();
  } else {
    assert("planted-regression target exists", false, `${target1} not found`);
  }

  // Planted regression 2: hardcoded MoltZap version in a non-baked doc.
  const moltzapVersion = readMoltzapVersion();
  plantFile(
    target1,
    (s) =>
      `${s}\nMoltZap compatibility pinned at ${moltzapVersion} for this run.\n`,
  );
  const r2 = runScript(
    "scripts/docs/check-no-hardcoded-constants.ts",
    workspaceRoot,
  );
  assert(
    "flags planted V2_PROTOCOL_VERSION literal",
    r2.code !== 0 && /V2_PROTOCOL_VERSION/.test(r2.stderr),
    `expected V2_PROTOCOL_VERSION hit. exit=${r2.code}, stderr=${r2.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  // Planted regression 3: a version that extends the baked value cannot
  // hide behind a prefix match.
  const compatibilityBakedTarget = "docs/spec/router-representation.md";
  plantFile(compatibilityBakedTarget, (s) =>
    s.replace(moltzapVersion, `${moltzapVersion}0`),
  );
  const r3 = runScript(
    "scripts/docs/check-no-hardcoded-constants.ts",
    workspaceRoot,
  );
  assert(
    "flags prefix-extending version drift inside a V2-baked document",
    r3.code !== 0 && /VERSION_SHAPED_LITERAL/.test(r3.stderr),
    `expected VERSION_SHAPED_LITERAL hit. exit=${r3.code}, stderr=${r3.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
};

// ─── Tests: check-doc-imports-resolve ─────────────────────────────────────

const testDocImportsResolve = (): void => {
  console.log("\n# check-doc-imports-resolve");
  const clean = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  assert(
    "clean tree exits 0",
    clean.code === 0,
    `expected exit 0, got ${clean.code}. stderr: ${clean.stderr}`,
  );

  // Planted regression 1: import from a non-existent subpath.
  const target1 = "docs/development/contributing.mdx";
  plantFile(
    target1,
    (s) =>
      `${s}\n\`\`\`typescript\nimport { foo } from "@moltzap/identity/does-not-exist";\n\`\`\`\n`,
  );
  const r1 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  assert(
    "flags unknown subpath",
    r1.code !== 0 && /unknown-subpath/.test(r1.stderr),
    `expected unknown-subpath. exit=${r1.code}, stderr=${r1.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  // Planted regression 2: named binding not exported from the resolved entry.
  plantFile(
    target1,
    (s) =>
      `${s}\n\`\`\`typescript\nimport { ThisSymbolDoesNotExist } from "@moltzap/identity";\n\`\`\`\n`,
  );
  const r2 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  assert(
    "flags missing named export",
    r2.code !== 0 && /missing-export/.test(r2.stderr),
    `expected missing-export. exit=${r2.code}, stderr=${r2.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  // Positive case: multi-line `import { ... } from "..."` block whose
  // bindings are unknown must still be flagged as missing-export. Locks
  // in that the joinMultiLineImports fold feeds IMPORT_RE rather than
  // silently skipping multi-line statements.
  plantFile(
    target1,
    (s) =>
      `${s}\n\`\`\`typescript\nimport {\n  ThisSymbolDoesNotExist,\n  AlsoNotExported,\n} from "@moltzap/identity";\n\`\`\`\n`,
  );
  const r4 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  assert(
    "multi-line import with unknown binding flagged as missing-export (joinMultiLineImports regression)",
    r4.code !== 0 &&
      /missing-export/.test(r4.stderr) &&
      /ThisSymbolDoesNotExist/.test(r4.stderr),
    `expected missing-export from folded multi-line import. exit=${r4.code}, stderr=${r4.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  // Positive case: multi-line `import { ... } from "..."` block whose
  // bindings ARE valid must NOT be flagged — confirms the fold doesn't
  // false-positive on legitimate multi-line imports.
  plantFile(
    target1,
    (s) =>
      `${s}\n\`\`\`typescript\nimport {\n  AgentId,\n  AgentName,\n} from "@moltzap/identity";\n\`\`\`\n`,
  );
  const r5 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  assert(
    "multi-line import with valid bindings still passes (joinMultiLineImports positive)",
    r5.code === 0,
    `expected clean pass, got exit=${r5.code}, stderr=${r5.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  // Pin the final package names, named root and capability bindings, and
  // their server composition subpaths together.
  plantFile(
    target1,
    (s) =>
      `${s}\n\`\`\`typescript\nimport { MOLTZAP_VERSION } from "@moltzap/identity";\nimport { Registry } from "@moltzap/identity/registry";\nimport "@moltzap/identity/registry/server";\nimport "@moltzap/router/server";\n\`\`\`\n`,
  );
  const r6 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  assert(
    "final identity and router package subpaths resolve",
    r6.code === 0,
    `expected final package imports to pass. exit=${r6.code}, stderr=${r6.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  plantFile(
    target1,
    (s) =>
      `${s}\n\`\`\`typescript\nimport { ThisIdentitySymbolDoesNotExist } from "@moltzap/identity";\n\`\`\`\n`,
  );
  const r7 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  assert(
    "flags missing identity named export",
    r7.code !== 0 &&
      /missing-export/.test(r7.stderr) &&
      /ThisIdentitySymbolDoesNotExist/.test(r7.stderr),
    `expected identity missing-export. exit=${r7.code}, stderr=${r7.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  plantFile(
    target1,
    (s) =>
      `${s}\n\`\`\`typescript\nimport "@moltzap/router/does-not-exist";\n\`\`\`\n`,
  );
  const r8 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  assert(
    "flags unknown router subpath",
    r8.code !== 0 && /unknown-subpath/.test(r8.stderr),
    `expected router unknown-subpath. exit=${r8.code}, stderr=${r8.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  plantFile("packages/router/package.json", (s) =>
    s.replace("./dist/server.js", "./dist/missing-server.js"),
  );
  plantFile(
    target1,
    (s) => `${s}\n\`\`\`typescript\nimport "@moltzap/router/server";\n\`\`\`\n`,
  );
  const r9 = runScript(
    "scripts/docs/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  assert(
    "flags a documented router subpath with no source or built target",
    r9.code !== 0 && /missing-target/.test(r9.stderr),
    `expected router missing-target. exit=${r9.code}, stderr=${r9.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
};

// ─── Tests: generate-constants-snippets fail-closed on bake failures ──────
//
// Locks in that an unknown constant name inside a `@bake-constants:` marker
// makes the generator collect a `BakeFileResult.failures` entry and exit
// non-zero — protects against silent-skip regressions where a typo'd
// constant name in a baked doc would be a no-op.

const testBakeFailureFailClosed = (): void => {
  console.log("\n# generate-constants-snippets bake-failure fail-closed");

  // Positive case: clean tree generates without failures.
  const clean = runGenerate(workspaceRoot);
  assert(
    "clean tree: generator exits 0",
    clean.code === 0,
    `expected exit 0, got ${clean.code}. stderr: ${clean.stderr.slice(0, 300)}`,
  );

  // Regression: plant an unknown constant name into an existing bake
  // marker. The bake step should see no matching constant and push a
  // BakeFailure, which trips the fail-closed exit.
  const target = "docs/spec/identity.md";
  plantFile(target, (s) =>
    s.replace(
      /\{\/\*\s*@bake-constants:\s*([^*]+?)\s*\*\/\}/,
      "{/* @bake-constants: $1 NOT_A_REAL_CONSTANT */}",
    ),
  );
  const r = runGenerate(workspaceRoot);
  assert(
    "unknown constant in bake marker triggers non-zero exit",
    r.code !== 0,
    `expected non-zero exit on unknown bake constant. exit=${r.code}, stderr=${r.stderr.slice(0, 300)}`,
  );
  assert(
    "bake-failure stderr names the unknown constant",
    /NOT_A_REAL_CONSTANT/.test(r.stderr) &&
      /marker lists unknown constant/.test(r.stderr),
    `expected NOT_A_REAL_CONSTANT + 'unknown constant' in stderr. stderr=${r.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
};

// ─── Tests: MoltZap compatibility authority ──────────────────────────────

const readMoltzapVersion = (): string => {
  const read = readMoltzapVersionSource(workspaceRoot);
  if ("error" in read) {
    throw new Error(read.error);
  }
  return read.value;
};

/** Rewrite the literal with the same pattern the readers match. */
const withMoltzapVersion =
  (next: string) =>
  (source: string): string =>
    source.replace(
      MOLTZAP_VERSION_LITERAL,
      `export const MOLTZAP_VERSION = "${next}"`,
    );

const testMoltzapVersionFile = (): void => {
  console.log("\n# MoltZap compatibility version source");

  plantFile(MOLTZAP_VERSION_SOURCE, withMoltzapVersion(""));
  const empty = runGenerateDirect();
  assert(
    "empty MoltZap version fails closed",
    empty.code !== 0 && /expected a nonempty version/.test(empty.stderr),
    `expected empty-version failure. exit=${empty.code}, stderr=${empty.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  const currentVersion = readMoltzapVersion();
  const nextVersion = "2099.999.8";
  const marker = "@bake-constants: V2_PROTOCOL_VERSION";
  const consumers = [
    ...walkFiles(resolve(workspaceRoot, "docs")),
    resolve(workspaceRoot, "README.md"),
  ]
    .filter((path) => /\.mdx?$/.test(path))
    .filter((path) => readFileSync(path, "utf8").includes(marker));
  for (const path of consumers) {
    assert(
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
  plantFile(MOLTZAP_VERSION_SOURCE, withMoltzapVersion(nextVersion));
  const bumped = runGenerateDirect();
  assert(
    "changed MoltZap version regenerates constants",
    bumped.code === 0,
    `expected successful regeneration. exit=${bumped.code}, stderr=${bumped.stderr.slice(0, 300)}`,
  );
  for (const path of consumers) {
    assert(
      `re-bakes MoltZap version: ${path.split("/").slice(-2).join("/")}`,
      readFileSync(path, "utf8").includes(nextVersion),
      `${path} did not contain ${nextVersion} after regeneration`,
    );
  }
  for (const path of generated) {
    assert(
      `regenerates MoltZap version snippet: ${path.split("/").slice(-2).join("/")}`,
      readFileSync(resolve(workspaceRoot, path), "utf8").includes(nextVersion),
      `${path} did not contain ${nextVersion} after regeneration`,
    );
  }
  restoreAllPlants();
};

// ─── Tests: architecture boundaries publication guards ───────────────────

const testPublicationGuards = (): void => {
  console.log("\n# check-boundaries publication guards");
  const clean = runBoundaries();
  assert(
    "clean tree passes the publication guards",
    clean.code === 0,
    `expected exit 0, got ${clean.code}. stderr: ${clean.stderr.slice(0, 300)}`,
  );

  plantFile("packages/nanoclaw-channel/package.json", (s) =>
    s.replace(/"version": "[^"]+"/, '"version": "2026.101.0"'),
  );
  const unequal = runBoundaries();
  assert(
    "flags a published manifest whose version differs from its siblings",
    unequal.code !== 0 && /must share one version/.test(unequal.stderr),
    `expected one-version failure. exit=${unequal.code}, stderr=${unequal.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  plantFile("packages/evals/package.json", (s) =>
    s.replace(/\s*"private": true,/, ""),
  );
  const publicEvals = runBoundaries();
  assert(
    "flags evals losing its private flag",
    publicEvals.code !== 0 &&
      /evals\/package\.json: must stay private/.test(publicEvals.stderr),
    `expected evals-private failure. exit=${publicEvals.code}, stderr=${publicEvals.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  plantFile("packages/identity/package.json", (s) =>
    s.replace('"version"', '"private": true,\n  "version"'),
  );
  const privateIdentity = runBoundaries();
  assert(
    "flags a published package that carries private",
    privateIdentity.code !== 0 &&
      /identity\/package\.json: a published package must not carry "private"/.test(
        privateIdentity.stderr,
      ),
    `expected published-private failure. exit=${privateIdentity.code}, stderr=${privateIdentity.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  plantFile("packages/router/package.json", (s) =>
    s.replace('"license": "Apache-2.0"', '"license": "MIT"'),
  );
  const wrongLicense = runBoundaries();
  assert(
    "flags a published package with another license",
    wrongLicense.code !== 0 &&
      /router\/package\.json: license is "MIT"/.test(wrongLicense.stderr),
    `expected license failure. exit=${wrongLicense.code}, stderr=${wrongLicense.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  plantFile("packages/router/NOTICE", (s) => `${s}Extra line.\n`);
  const driftedNotice = runBoundaries();
  assert(
    "flags a packaged NOTICE that differs from the repository NOTICE",
    driftedNotice.code !== 0 &&
      /router\/NOTICE: must be an identical copy/.test(driftedNotice.stderr),
    `expected NOTICE drift failure. exit=${driftedNotice.code}, stderr=${driftedNotice.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  plantFile("packages/router/package.json", (s) =>
    s.replace(
      "git+https://github.com/chughtapan/moltzap.git",
      "https://example.invalid/fork.git",
    ),
  );
  const foreignRepository = runBoundaries();
  assert(
    "flags a published package pointing at another repository",
    foreignRepository.code !== 0 &&
      /router\/package\.json: repository\.url must be/.test(
        foreignRepository.stderr,
      ),
    `expected repository failure. exit=${foreignRepository.code}, stderr=${foreignRepository.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  plantFile("packages/router/package.json", (s) =>
    s.replace(/"version": "[^"]+"/, '"version": "1.2.3"'),
  );
  const semver = runBoundaries();
  assert(
    "flags a published manifest whose version is not a calendar version",
    semver.code !== 0 &&
      /router\/package\.json: version "1\.2\.3" is not a YYYY\.MDD\.N CalVer/.test(
        semver.stderr,
      ),
    `expected calver failure. exit=${semver.code}, stderr=${semver.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  plantFile(MOLTZAP_VERSION_SOURCE, withMoltzapVersion("1.2.3"));
  const wireSemver = runBoundaries();
  assert(
    "flags a wire compatibility literal that is not a calendar version",
    wireSemver.code !== 0 &&
      /MOLTZAP_VERSION "1\.2\.3" is not a YYYY\.MDD\.N CalVer/.test(
        wireSemver.stderr,
      ),
    `expected wire-literal failure. exit=${wireSemver.code}, stderr=${wireSemver.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  plantFile(".github/workflows/publish.yml", (s) =>
    s.replace(/^(\s*RELEASE_PACKAGES:\s*).+$/m, "$1identity router"),
  );
  const driftedList = runBoundaries();
  assert(
    "flags a release package list that drifted from the published set",
    driftedList.code !== 0 &&
      /RELEASE_PACKAGES drifted from the published set/.test(
        driftedList.stderr,
      ),
    `expected release-list failure. exit=${driftedList.code}, stderr=${driftedList.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
};

const testNodeVersionFloorConsistency = (): void => {
  console.log("\n# Node version floor consistency");
  const workspaceManifest = JSON.parse(
    readFileSync(resolve(workspaceRoot, "package.json"), "utf8"),
  ) as { readonly engines?: { readonly node?: string } };
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
  assert(
    "workspace and pinned runtime support Node.js 22+",
    workspaceNodeRange?.startsWith(">=22.") === true &&
      pinnedMajor >= 22 &&
      pinnedMajor < 25,
    `expected a pinned Node.js 22–24 runtime, got engines.node=${String(workspaceNodeRange)} and .node-version=${pinnedNode}`,
  );
  assert(
    "quickstart matches the workspace Node.js range",
    quickstartDocs.includes(`Node.js \`${String(workspaceNodeRange)}\``),
    `quickstart does not advertise Node.js \`${String(workspaceNodeRange)}\``,
  );
};

// ─── Tests: generate-constants-snippets idempotence ───────────────────────

const testGeneratorIdempotence = (): void => {
  console.log("\n# generate-constants-snippets idempotence");
  // Capture the values.json + values.mdx before running.
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
  // Capture all baked docs known to use the marker.
  const bakedFiles = [
    ...walkFiles(resolve(workspaceRoot, "docs")),
    resolve(workspaceRoot, "README.md"),
  ]
    .filter((path) => /\.mdx?$/.test(path))
    .filter((path) => readFileSync(path, "utf8").includes("@bake-constants:"))
    .sort();
  const before = bakedFiles.map((p) => readFileSync(p, "utf8"));

  const r = runGenerate(workspaceRoot);
  assert(
    "generator runs to completion",
    r.code === 0,
    `generator exit ${r.code}: ${r.stderr.slice(0, 300)}`,
  );
  assert(
    "values.json unchanged after re-generate",
    readFileSync(valuesJsonPath, "utf8") === beforeJson,
    "values.json contents drifted across re-runs",
  );
  assert(
    "values.mdx unchanged after re-generate",
    readFileSync(valuesMdxPath, "utf8") === beforeMdx,
    "values.mdx contents drifted across re-runs",
  );
  for (let i = 0; i < bakedFiles.length; i++) {
    const after = readFileSync(bakedFiles[i] ?? "", "utf8");
    assert(
      `baked file unchanged: ${bakedFiles[i]?.split("/").slice(-2).join("/")}`,
      after === before[i],
      `${bakedFiles[i]} drifted across re-runs`,
    );
  }
};

// ─── Entry point ──────────────────────────────────────────────────────────

const main = (): void => {
  try {
    testNoHardcodedConstants();
    testDocImportsResolve();
    // Idempotence runs BEFORE the fail-closed test because the fail-closed
    // test calls runGenerate() on the clean tree as its positive case,
    // which writes generated outputs to disk. Snapshotting the baseline
    // here first ensures idempotence captures the pre-test on-disk state
    // rather than the post-clean-runGenerate state — eliminating
    // order-of-test coupling between the two suites.
    testGeneratorIdempotence();
    testMoltzapVersionFile();
    testBakeFailureFailClosed();
    testNodeVersionFloorConsistency();
    testPublicationGuards();
  } finally {
    restoreAllPlants();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll gate + generator tests passed.");
};

main();
