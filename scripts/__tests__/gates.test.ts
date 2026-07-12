#!/usr/bin/env tsx
/**
 * @file Gate + generator smoke tests. Plain Node, no vitest config —
 * runs the three doc-side scripts under controlled mutations to a
 * temp workspace mirror and asserts (1) the gates pass on the clean
 * snapshot, (2) gates flag every planted regression, (3) the
 * constants generator is idempotent across re-runs.
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
  const r = spawnSync(
    "pnpm",
    ["--filter", "@moltzap/server-core", "exec", "tsx", `../../${script}`],
    { cwd, encoding: "utf8" },
  );
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
    [
      "--filter",
      "@moltzap/server-core",
      "exec",
      "tsx",
      "../../scripts/generate-constants-snippets.ts",
    ],
    { cwd, encoding: "utf8" },
  );
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

/**
 * Run the generator without asking pnpm to parse every workspace manifest.
 * This lets the negative-path tests deliberately corrupt protocol/package.json
 * and prove the generator itself fails closed.
 */
const runGenerateDirect = (
  cwd: string,
): { code: number; stdout: string; stderr: string } => {
  const tsxCli = resolve(
    workspaceRoot,
    "packages/server/node_modules/tsx/dist/cli.mjs",
  );
  const r = spawnSync(
    process.execPath,
    [tsxCli, resolve(workspaceRoot, "scripts/generate-constants-snippets.ts")],
    { cwd, encoding: "utf8" },
  );
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

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
    "scripts/check-no-hardcoded-constants.ts",
    workspaceRoot,
  );
  assert(
    "clean tree exits 0",
    clean.code === 0,
    `expected exit 0, got ${clean.code}. stderr: ${clean.stderr}`,
  );

  // Planted regression 1: hardcoded PROTOCOL_VERSION in a non-baked doc.
  const target1 = "docs/development/local-setup.mdx";
  if (existsSync(resolve(workspaceRoot, target1))) {
    plantFile(
      target1,
      (s) => `${s}\nProtocol pinned at 2026.524.1 for this run.\n`,
    );
    const r1 = runScript(
      "scripts/check-no-hardcoded-constants.ts",
      workspaceRoot,
    );
    assert(
      "flags planted PROTOCOL_VERSION literal",
      r1.code !== 0 &&
        /PROTOCOL_VERSION|VERSION_SHAPED_LITERAL/.test(r1.stderr),
      `expected non-zero exit + PROTOCOL_VERSION hit. exit=${r1.code}, stderr=${r1.stderr.slice(0, 300)}`,
    );
    restoreAllPlants();
  } else {
    assert("planted-regression target exists", false, `${target1} not found`);
  }

  // Planted regression 2: stale port 3100.
  const target2 = "docs/quickstart.mdx";
  plantFile(target2, (s) => `${s}\nLegacy bind: PORT=3100 npx old-server\n`);
  const r2 = runScript(
    "scripts/check-no-hardcoded-constants.ts",
    workspaceRoot,
  );
  assert(
    "flags stale port 3100",
    r2.code !== 0 && /STALE_PORT_3100/.test(r2.stderr),
    `expected STALE_PORT_3100 hit. exit=${r2.code}, stderr=${r2.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  // Planted regression 3: API_KEY_PREFIX in generated-looking copy.
  const target3 = "docs/development/local-setup.mdx";
  plantFile(
    target3,
    (s) => `${s}\nExample credential: moltzap_agent_deadbeef\n`,
  );
  const r3 = runScript(
    "scripts/check-no-hardcoded-constants.ts",
    workspaceRoot,
  );
  assert(
    "flags planted API_KEY_PREFIX",
    r3.code !== 0 && /API_KEY_PREFIX/.test(r3.stderr),
    `expected API_KEY_PREFIX hit. exit=${r3.code}, stderr=${r3.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();
};

// ─── Tests: check-doc-imports-resolve ─────────────────────────────────────

const testDocImportsResolve = (): void => {
  console.log("\n# check-doc-imports-resolve");
  const clean = runScript(
    "scripts/check-doc-imports-resolve.ts",
    workspaceRoot,
  );
  assert(
    "clean tree exits 0",
    clean.code === 0,
    `expected exit 0, got ${clean.code}. stderr: ${clean.stderr}`,
  );

  // Planted regression 1: import from a non-existent subpath.
  const target1 = "docs/development/local-setup.mdx";
  plantFile(
    target1,
    (s) =>
      `${s}\n\`\`\`typescript\nimport { foo } from "@moltzap/server-core/does-not-exist";\n\`\`\`\n`,
  );
  const r1 = runScript("scripts/check-doc-imports-resolve.ts", workspaceRoot);
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
      `${s}\n\`\`\`typescript\nimport { ThisSymbolDoesNotExist } from "@moltzap/server-core";\n\`\`\`\n`,
  );
  const r2 = runScript("scripts/check-doc-imports-resolve.ts", workspaceRoot);
  assert(
    "flags missing named export",
    r2.code !== 0 && /missing-export/.test(r2.stderr),
    `expected missing-export. exit=${r2.code}, stderr=${r2.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  // Planted regression 3: import from a package that isn't in packages/.
  plantFile(
    target1,
    (s) =>
      `${s}\n\`\`\`typescript\nimport { x } from "@moltzap/never-shipped";\n\`\`\`\n`,
  );
  const r3 = runScript("scripts/check-doc-imports-resolve.ts", workspaceRoot);
  assert(
    "flags unknown package",
    r3.code !== 0 && /unknown-package/.test(r3.stderr),
    `expected unknown-package. exit=${r3.code}, stderr=${r3.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  // Positive case: multi-line `import { ... } from "..."` block whose
  // bindings are unknown must still be flagged as missing-export. Locks
  // in that the joinMultiLineImports fold feeds IMPORT_RE rather than
  // silently skipping multi-line statements. Uses the main barrel
  // (`@moltzap/server-core`) because `./test-utils` re-exports through
  // `export *` and the resolver skips named-binding checks when the
  // target entry has a star export.
  plantFile(
    target1,
    (s) =>
      `${s}\n\`\`\`typescript\nimport {\n  ThisSymbolDoesNotExist,\n  AlsoNotExported,\n} from "@moltzap/server-core";\n\`\`\`\n`,
  );
  const r4 = runScript("scripts/check-doc-imports-resolve.ts", workspaceRoot);
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
      `${s}\n\`\`\`typescript\nimport {\n  startCoreTestServer,\n  stopCoreTestServer,\n} from "@moltzap/server-core/test-utils";\n\`\`\`\n`,
  );
  const r5 = runScript("scripts/check-doc-imports-resolve.ts", workspaceRoot);
  assert(
    "multi-line import with valid bindings still passes (joinMultiLineImports positive)",
    r5.code === 0,
    `expected clean pass, got exit=${r5.code}, stderr=${r5.stderr.slice(0, 300)}`,
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
  const target = "docs/quickstart.mdx";
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

// ─── Tests: package manifest is the protocol-version authority ───────────

const testProtocolVersionManifest = (): void => {
  console.log("\n# protocol package version source");
  const manifestPath = "packages/protocol/package.json";

  plantFile(manifestPath, () => "{");
  const malformed = runGenerateDirect(workspaceRoot);
  assert(
    "malformed protocol manifest fails closed",
    malformed.code !== 0 && /could not parse/.test(malformed.stderr),
    `expected parse failure. exit=${malformed.code}, stderr=${malformed.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  plantFile(manifestPath, (source) => {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    Reflect.deleteProperty(parsed, "version");
    return `${JSON.stringify(parsed, null, 2)}\n`;
  });
  const missing = runGenerateDirect(workspaceRoot);
  assert(
    "missing protocol package version fails closed",
    missing.code !== 0 &&
      /expected a string version field/.test(missing.stderr),
    `expected missing-version failure. exit=${missing.code}, stderr=${missing.stderr.slice(0, 300)}`,
  );
  restoreAllPlants();

  const currentVersion = JSON.parse(
    readFileSync(resolve(workspaceRoot, manifestPath), "utf8"),
  ).version as string;
  const nextVersion = "2099.999.9";
  const marker = "@bake-constants:";
  const consumers = [
    ...walkFiles(resolve(workspaceRoot, "docs")),
    resolve(workspaceRoot, "README.md"),
  ]
    .filter((path) => /\.mdx?$/.test(path))
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      return (
        source.includes(marker) &&
        source.includes("PROTOCOL_VERSION") &&
        source.includes(currentVersion)
      );
    });
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
  plantFile(manifestPath, (source) => {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    parsed.version = nextVersion;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  });
  const bumped = runGenerateDirect(workspaceRoot);
  assert(
    "changed package version regenerates constants",
    bumped.code === 0,
    `expected successful regeneration. exit=${bumped.code}, stderr=${bumped.stderr.slice(0, 300)}`,
  );
  for (const path of consumers) {
    assert(
      `re-bakes protocol version: ${path.split("/").slice(-2).join("/")}`,
      readFileSync(path, "utf8").includes(nextVersion),
      `${path} did not contain ${nextVersion} after regeneration`,
    );
  }
  for (const path of generated) {
    assert(
      `regenerates protocol version snippet: ${path.split("/").slice(-2).join("/")}`,
      readFileSync(resolve(workspaceRoot, path), "utf8").includes(nextVersion),
      `${path} did not contain ${nextVersion} after regeneration`,
    );
  }
  restoreAllPlants();
};

const testPublishWorkflowVersionFlow = (): void => {
  console.log("\n# publish workflow protocol version flow");
  const workflow = readFileSync(
    resolve(workspaceRoot, ".github/workflows/publish.yml"),
    "utf8",
  );
  const manifestWrite = workflow.indexOf(
    'jq --arg v "$VERSION" \'.version = $v\' "packages/$pkg/package.json"',
  );
  const build = workflow.indexOf("pnpm build", manifestWrite);
  const docs = workflow.indexOf("pnpm docs:generate", build);
  const stage = workflow.indexOf(
    "git add packages/*/package.json pnpm-lock.yaml",
    docs,
  );
  assert(
    "release mutates only the package manifest version source",
    manifestWrite >= 0 &&
      !workflow.includes("packages/protocol/src/version.ts") &&
      !/sed .*PROTOCOL_VERSION/.test(workflow),
    "expected a package.json version write with no source-file mutation",
  );
  assert(
    "release rebuilds and regenerates docs before staging",
    manifestWrite < build && build < docs && docs < stage,
    `expected manifest → build → docs → stage ordering; indices=${manifestWrite},${build},${docs},${stage}`,
  );
};

const testNodeVersionFloorConsistency = (): void => {
  console.log("\n# Node version floor consistency");
  const protocolManifest = JSON.parse(
    readFileSync(
      resolve(workspaceRoot, "packages/protocol/package.json"),
      "utf8",
    ),
  ) as { readonly engines?: { readonly node?: string } };
  const quickstart = readFileSync(
    resolve(workspaceRoot, "scripts/quickstart.sh"),
    "utf8",
  );
  const quickstartDocs = readFileSync(
    resolve(workspaceRoot, "docs/quickstart.mdx"),
    "utf8",
  );
  const localSetupDocs = readFileSync(
    resolve(workspaceRoot, "docs/development/local-setup.mdx"),
    "utf8",
  );
  assert(
    "protocol package declares Node.js 22+",
    protocolManifest.engines?.node === ">=22.0.0",
    `expected engines.node >=22.0.0, got ${String(protocolManifest.engines?.node)}`,
  );
  assert(
    "quickstart preflight enforces Node.js 22+",
    quickstart.includes("install Node.js 22+") &&
      quickstart.includes('if [ "$node_major" -lt 22 ]') &&
      quickstart.includes("Node.js 22+ required"),
    "scripts/quickstart.sh does not consistently enforce Node.js 22+",
  );
  assert(
    "setup docs advertise Node.js 22+",
    quickstartDocs.includes("Node.js 22+") &&
      localSetupDocs.includes("Node.js 22+"),
    "quickstart or local-setup docs have a different Node.js floor",
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
    "docs/quickstart.mdx",
    "docs/protocol/overview.mdx",
    "docs/cli/configuration.mdx",
    "docs/integrations/openclaw.mdx",
    "docs/guides/user-agent-communication.mdx",
    "docs/cli/overview.mdx",
    "docs/guides/two-agent-chat.mdx",
    "docs/snippets/env-vars-table.mdx",
  ].map((p) => resolve(workspaceRoot, p));
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
    testProtocolVersionManifest();
    testBakeFailureFailClosed();
    testPublishWorkflowVersionFlow();
    testNodeVersionFloorConsistency();
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
