#!/usr/bin/env node
/**
 * Mechanical guard for the v2 package boundary law.
 *
 * The frozen architecture fixes six v2 packages, one shared CalVer, an
 * exact export/binary map, and an exact dependency DAG. Nothing here is
 * inferred from the tree: every expectation is written down below and the
 * repository is checked against it, so drift in either direction fails.
 *
 * Each rule asserts its own input set is non-empty before it reports
 * success. A boundary check that walks nothing passes vacuously and is
 * indistinguishable from no check at all.
 */
const fs = require("node:fs");
const path = require("node:path");

const repo = process.cwd();
const v2Root = path.join(repo, "v2");
const failures = [];

// The frozen package map. `deps` lists the only v2 packages a package may
// depend on, in package.json, in TypeScript project references, and in
// source imports alike.
const PACKAGES = {
  identity: {
    npmName: "@moltzap/v2-identity",
    deps: [],
    exports: [".", "./server"],
    bin: ["moltzap-directory"],
  },
  transport: {
    npmName: "@moltzap/v2-transport",
    deps: ["identity"],
    exports: [".", "./server"],
    bin: ["moltzap-router"],
  },
  transcript: {
    npmName: "@moltzap/v2-transcript",
    deps: ["identity", "transport"],
    exports: [".", "./server"],
    bin: ["moltzap-ledger"],
  },
  endpoint: {
    npmName: "@moltzap/v2-endpoint",
    deps: ["identity", "transport", "transcript"],
    exports: [".", "./server"],
    bin: ["moltzap", "moltzap-agentd"],
  },
  simulator: {
    npmName: "@moltzap/v2-simulator",
    deps: ["identity", "endpoint"],
    exports: [".", "./adapter", "./ledger"],
    bin: [],
  },
  testbed: {
    npmName: "@moltzap/v2-testbed",
    deps: ["identity", "transport", "transcript", "endpoint", "simulator"],
    exports: ["."],
    bin: [],
  },
};

// Simulator and testbed are experiment and acquisition machinery. The four
// packages that ship the product must never reach for them.
const PRODUCTION = ["identity", "transport", "transcript", "endpoint"];
const NON_PRODUCTION = ["simulator", "testbed"];

const dirByNpmName = new Map(
  Object.entries(PACKAGES).map(([dir, meta]) => [meta.npmName, dir]),
);

function fail(message) {
  failures.push(message);
}

function failAt(file, line, message) {
  failures.push(`${path.relative(repo, file)}:${line}: ${message}`);
}

function lineAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function walkTypeScript(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTypeScript(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Every module specifier in a file, whether static, dynamic, or require.
function importSpecifiers(text) {
  const pattern =
    /(?:^|[^\w$])(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  const found = [];
  for (const match of text.matchAll(pattern)) {
    found.push({ specifier: match[1], index: match.index });
  }
  return found;
}

// A specifier belongs to workspace package `name` when it is the bare name
// or one of its subpath exports, never when it merely shares a prefix.
function isImportOf(specifier, name) {
  return specifier === name || specifier.startsWith(`${name}/`);
}

// ─── The v2 package set is exactly six ────────────────────────────────────

const expectedDirs = Object.keys(PACKAGES).sort();
const actualDirs = fs.existsSync(v2Root)
  ? fs
      .readdirSync(v2Root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(path.join(v2Root, entry.name, "package.json")),
      )
      .map((entry) => entry.name)
      .sort()
  : [];

if (JSON.stringify(actualDirs) !== JSON.stringify(expectedDirs)) {
  fail(
    `v2/: package set drifted; expected exactly ${expectedDirs.join(", ")}, found ${actualDirs.join(", ") || "none"}`,
  );
}

// ─── One CalVer, carried by v2/VERSION and all six manifests ──────────────

const versionFile = path.join(v2Root, "VERSION");
let declaredVersion = null;
if (!fs.existsSync(versionFile)) {
  fail("v2/VERSION: missing; it is the sole MoltZap compatibility value");
} else {
  declaredVersion = fs.readFileSync(versionFile, "utf8").trim();
  if (!/^\d{4}\.\d{3,4}\.\d+$/.test(declaredVersion)) {
    fail(`v2/VERSION: "${declaredVersion}" is not a YYYY.MDD.PATCH CalVer`);
  }
}

// ─── Manifests: version, privacy, exports, binaries, dependencies ─────────

for (const dir of actualDirs) {
  const expected = PACKAGES[dir];
  const manifestPath = path.join(v2Root, dir, "package.json");
  const manifest = readJson(manifestPath);
  const where = `v2/${dir}/package.json`;

  if (expected === undefined) continue;

  if (manifest.name !== expected.npmName) {
    fail(
      `${where}: name is "${manifest.name}", expected "${expected.npmName}"`,
    );
  }

  if (declaredVersion !== null && manifest.version !== declaredVersion) {
    fail(
      `${where}: version "${manifest.version}" does not match v2/VERSION "${declaredVersion}"`,
    );
  }

  if (manifest.private !== true) {
    fail(`${where}: must set "private": true; v2 publishes nothing`);
  }

  const actualExports = Object.keys(manifest.exports ?? {}).sort();
  const wantedExports = [...expected.exports].sort();
  if (JSON.stringify(actualExports) !== JSON.stringify(wantedExports)) {
    fail(
      `${where}: exports drifted; expected ${wantedExports.join(", ")}, got ${actualExports.join(", ") || "none"}`,
    );
  }

  const actualBin = Object.keys(manifest.bin ?? {}).sort();
  const wantedBin = [...expected.bin].sort();
  if (JSON.stringify(actualBin) !== JSON.stringify(wantedBin)) {
    fail(
      `${where}: binaries drifted; expected ${wantedBin.join(", ") || "none"}, got ${actualBin.join(", ") || "none"}`,
    );
  }

  // Binaries are checked in rather than built, so the target exists at
  // install time and a declared binary can never be a dangling link.
  for (const [name, target] of Object.entries(manifest.bin ?? {})) {
    if (!fs.existsSync(path.join(v2Root, dir, target))) {
      fail(`${where}: binary "${name}" points at missing file "${target}"`);
    }
  }

  const actualDeps = Object.keys(manifest.dependencies ?? {})
    .filter((name) => dirByNpmName.has(name))
    .sort();
  const wantedDeps = expected.deps.map((d) => PACKAGES[d].npmName).sort();
  if (JSON.stringify(actualDeps) !== JSON.stringify(wantedDeps)) {
    fail(
      `${where}: v2 dependencies violate the frozen DAG; expected ${wantedDeps.join(", ") || "none"}, got ${actualDeps.join(", ") || "none"}`,
    );
  }

  // Project references must encode the same DAG, or `tsc -b` and the
  // manifest disagree about what this package may reach.
  const tsconfigPath = path.join(v2Root, dir, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    fail(`v2/${dir}/tsconfig.json: missing`);
  } else {
    const refs = (readJson(tsconfigPath).references ?? [])
      .map((ref) => path.basename(ref.path))
      .sort();
    const wantedRefs = [...expected.deps].sort();
    if (JSON.stringify(refs) !== JSON.stringify(wantedRefs)) {
      fail(
        `v2/${dir}/tsconfig.json: project references violate the frozen DAG; expected ${wantedRefs.join(", ") || "none"}, got ${refs.join(", ") || "none"}`,
      );
    }
  }
}

// ─── Import rules over v2 and v1 source ───────────────────────────────────

// Workspace packages whose source lives under packages/ are v1. Resolving
// the rule against the real workspace layout keeps it correct no matter how
// either track names its packages.
const v1PackageNames = new Set();
const packagesRoot = path.join(repo, "packages");
if (fs.existsSync(packagesRoot)) {
  for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    const manifestPath = path.join(packagesRoot, entry.name, "package.json");
    if (entry.isDirectory() && fs.existsSync(manifestPath)) {
      v1PackageNames.add(readJson(manifestPath).name);
    }
  }
}
if (v1PackageNames.size === 0) {
  fail(
    "packages/: no v1 workspace manifests found; the v2-imports-no-v1 rule would pass vacuously",
  );
}

const filesByPackage = new Map(
  actualDirs.map((dir) => [dir, walkTypeScript(path.join(v2Root, dir), [])]),
);

for (const [dir, files] of filesByPackage) {
  if (files.length === 0) {
    fail(
      `v2/${dir}: no TypeScript sources scanned; the import rules would pass vacuously here`,
    );
  }
}

for (const [dir, files] of filesByPackage) {
  const allowed = new Set(PACKAGES[dir]?.deps ?? []);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const { specifier, index } of importSpecifiers(text)) {
      const line = lineAt(text, index);

      // Rule 1 — v2 imports nothing from v1, by package name or by
      // reaching into the packages/ tree with a relative path.
      const v1Name = [...v1PackageNames].find((name) =>
        isImportOf(specifier, name),
      );
      if (v1Name !== undefined) {
        failAt(file, line, `v2 must not import v1 package "${v1Name}"`);
        continue;
      }
      if (
        /(^|\/)\.\.\/packages\//.test(specifier) ||
        specifier.startsWith("../packages/")
      ) {
        failAt(
          file,
          line,
          `v2 must not reach into packages/ by relative path ("${specifier}")`,
        );
        continue;
      }

      const targetDir = [...dirByNpmName.entries()].find(([npmName]) =>
        isImportOf(specifier, npmName),
      )?.[1];
      if (targetDir === undefined || targetDir === dir) continue;

      // Rule 2 — nothing that ships the product may import the simulator
      // or the testbed. Checked before the DAG so the violation is named
      // for what it actually is.
      if (PRODUCTION.includes(dir) && NON_PRODUCTION.includes(targetDir)) {
        failAt(
          file,
          line,
          `production package "${dir}" must not import non-production package "${targetDir}"`,
        );
        continue;
      }

      // Rule 3 — every remaining cross-package import follows the DAG.
      if (!allowed.has(targetDir)) {
        failAt(
          file,
          line,
          `dependency DAG violation: "${dir}" may not import "${targetDir}" (allowed: ${[...allowed].join(", ") || "none"})`,
        );
      }
    }
  }
}

// Rule 2 also binds v1: no shipped v1 package may reach into v2 machinery.
const v1Files = walkTypeScript(packagesRoot, []);
if (v1Files.length === 0) {
  fail(
    "packages/: no TypeScript sources scanned; rule 2 would pass vacuously over v1",
  );
}
for (const file of v1Files) {
  const text = fs.readFileSync(file, "utf8");
  for (const { specifier, index } of importSpecifiers(text)) {
    const target = NON_PRODUCTION.find((dir) =>
      isImportOf(specifier, PACKAGES[dir].npmName),
    );
    if (target !== undefined) {
      failAt(
        file,
        lineAt(text, index),
        `production package must not import non-production package "${target}"`,
      );
    }
  }
}

// ─── The compatibility value is exported, and matches ─────────────────────

const identityIndex = path.join(v2Root, "identity", "src", "index.ts");
if (declaredVersion !== null) {
  if (!fs.existsSync(identityIndex)) {
    fail(
      "v2/identity/src/index.ts: missing; it exports the compatibility value",
    );
  } else {
    const text = fs.readFileSync(identityIndex, "utf8");
    const match = text.match(
      /export\s+const\s+MOLTZAP_VERSION\s*=\s*["']([^"']+)["']/,
    );
    if (match === null) {
      fail(
        "v2/identity/src/index.ts: must export MOLTZAP_VERSION, the MoltZap compatibility value",
      );
    } else if (match[1] !== declaredVersion) {
      fail(
        `v2/identity/src/index.ts: MOLTZAP_VERSION "${match[1]}" does not match v2/VERSION "${declaredVersion}"`,
      );
    }
  }
}

// ─── Report ───────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error("[check-v2-boundaries] FAIL");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

const scanned = [...filesByPackage.values()].reduce(
  (total, files) => total + files.length,
  0,
);
console.log(
  `[check-v2-boundaries] OK — ${actualDirs.length} packages, ${scanned} v2 sources, ${v1Files.length} v1 sources scanned at version ${declaredVersion}`,
);
