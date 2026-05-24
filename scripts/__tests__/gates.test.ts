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
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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

  // Planted regression 3: HELLO_MAX_MESSAGE_BYTES in JSON-shaped context.
  const target3 = "docs/development/local-setup.mdx";
  plantFile(
    target3,
    (s) => `${s}\nExample policy: { "maxMessageBytes": 65536 }\n`,
  );
  const r3 = runScript(
    "scripts/check-no-hardcoded-constants.ts",
    workspaceRoot,
  );
  assert(
    "flags HELLO_MAX_MESSAGE_BYTES in JSON",
    r3.code !== 0 && /HELLO_MAX_MESSAGE_BYTES/.test(r3.stderr),
    `expected HELLO_MAX_MESSAGE_BYTES hit. exit=${r3.code}, stderr=${r3.stderr.slice(0, 300)}`,
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
  // Capture all baked docs (the 10 files known to use the marker).
  const bakedFiles = [
    "docs/quickstart.mdx",
    "docs/server/overview.mdx",
    "docs/server/configuration.mdx",
    "docs/protocol/overview.mdx",
    "docs/cli/configuration.mdx",
    "docs/integrations/openclaw.mdx",
    "docs/guides/user-agent-communication.mdx",
    "docs/cli/overview.mdx",
    "docs/guides/two-agent-chat.mdx",
    "docs/guides/custom-identity-provider.mdx",
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
    testGeneratorIdempotence();
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
