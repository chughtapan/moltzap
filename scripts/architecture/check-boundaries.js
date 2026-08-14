#!/usr/bin/env node
/**
 * Architecture boundary checks for the final product graph.
 *
 * Shared `packages/*` rules cover wildcard exports and barrel discipline. The
 * final-package table pins the directory and package names, public entrypoints,
 * binaries, manifest edges, TypeScript references, and required Nx targets for
 * all seven products. Client also pins each retired CLI and Unix-RPC artifact.
 *
 * The final-package table is a hand transcription of the current package
 * contract. It is written down rather than derived so drift fails whichever
 * side moves, but it is not self-certifying: re-verify it against
 * docs/spec/layer-interfaces.md whenever that contract changes.
 *
 * Every rule asserts its input set is non-empty before reporting success. A
 * check that walks nothing passes vacuously and is indistinguishable from no
 * check at all.
 */
const fs = require("node:fs");
const path = require("node:path");

const repo = process.cwd();
const v2Root = path.join(repo, "v2");
const packagesRoot = path.join(repo, "packages");
const failures = [];

// `deps` lists the only product packages each package may reach in manifests,
// TypeScript project references, Knip ignores, source imports, and the resolved
// Nx graph. `targets` is a minimum floor: additional operator targets are
// allowed, but deleting a required verification or product entry target fails.
const FINAL_PACKAGES = {
  identity: {
    npmName: "@moltzap/identity",
    deps: [],
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./registry": {
        types: "./dist/registry.d.ts",
        import: "./dist/registry.js",
      },
      "./registry/server": {
        types: "./dist/registry/server.d.ts",
        import: "./dist/registry/server.js",
      },
    },
    bin: { "moltzap-registry": "./bin/moltzap-registry" },
    targets: [
      "arch:check",
      "build",
      "lint",
      "test",
      "test:integration",
      "typecheck",
      "typecheck:tests",
    ],
  },
  router: {
    npmName: "@moltzap/router",
    deps: ["identity"],
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./server": {
        types: "./dist/server.d.ts",
        import: "./dist/server.js",
      },
    },
    bin: { "moltzap-router": "./bin/moltzap-router" },
    targets: [
      "arch:check",
      "build",
      "lint",
      "test",
      "test:integration",
      "typecheck",
      "typecheck:tests",
    ],
  },
  client: {
    npmName: "@moltzap/client",
    deps: ["identity", "router"],
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./server": {
        types: "./dist/server.d.ts",
        import: "./dist/server.js",
      },
    },
    bin: { moltzapd: "./bin/moltzapd" },
    targets: [
      "arch:check",
      "build",
      "lint",
      "test",
      "test:integration",
      "test:pack",
      "typecheck:tests",
    ],
  },
  "openclaw-channel": {
    npmName: "@moltzap/openclaw-channel",
    deps: ["client"],
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    },
    bin: {},
    targets: [
      "arch:check",
      "build",
      "lint",
      "test",
      "test:pack",
      "typecheck:tests",
    ],
  },
  "nanoclaw-channel": {
    npmName: "@moltzap/nanoclaw-channel",
    deps: ["client"],
    exports: {
      ".": {
        types: "./dist/channels/moltzap.d.ts",
        import: "./dist/channels/moltzap.js",
      },
    },
    bin: {},
    targets: ["arch:check", "build", "lint", "test", "typecheck:tests"],
  },
  simulator: {
    npmName: "@moltzap/simulator",
    deps: ["identity", "router", "client"],
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./network": {
        types: "./dist/network/index.d.ts",
        import: "./dist/network/index.js",
      },
      "./ledger": {
        types: "./dist/ledger/index.d.ts",
        import: "./dist/ledger/index.js",
      },
      "./agents": {
        types: "./dist/agents/index.d.ts",
        import: "./dist/agents/index.js",
      },
    },
    bin: {},
    targets: [
      "arch:check",
      "build",
      "gke-profile-check",
      "gke-run",
      "lint",
      "local-cluster-create",
      "local-cluster-test",
      "local-profile-check",
      "local-run",
      "test",
      "test:pack",
      "typecheck:tests",
    ],
  },
  evals: {
    npmName: "@moltzap/evals",
    deps: ["client", "simulator"],
    exports: {},
    bin: {},
    targets: [
      "arch:check",
      "build",
      "calibrate",
      "eval",
      "lint",
      "phoenix-terraform-check",
      "publish",
      "resume",
      "test",
      "typecheck:tests",
    ],
  },
};

const FINAL_PACKAGE_DIRS = Object.keys(FINAL_PACKAGES);
const FINAL_PACKAGE_NAMES = new Set(
  Object.values(FINAL_PACKAGES).map(({ npmName }) => npmName),
);
const RETIRED_PACKAGE_NAMES = new Set([
  "@moltzap/protocol",
  "@moltzap/server",
  "@moltzap/server-core",
  "@moltzap/transcript",
  "@moltzap/ledger",
  "@moltzap/harness",
  "@moltzap/testbed",
]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const CODE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

function walkCodeFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkCodeFiles(full, out);
    else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function walkNonDocumentationFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "dist" ||
      entry.name === "node_modules" ||
      entry.name === ".eslintcache"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkNonDocumentationFiles(full, out);
    } else if (
      entry.isFile() &&
      path.extname(entry.name) !== ".md" &&
      path.extname(entry.name) !== ".mdx"
    ) {
      out.push(full);
    }
  }
  return out;
}

function directoryContainsFile(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true;
    if (
      entry.isDirectory() &&
      directoryContainsFile(path.join(dir, entry.name))
    ) {
      return true;
    }
  }
  return false;
}

function rel(file) {
  return path.relative(repo, file);
}

function lineAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Every boundary rule compares two name sets, so every one reports drift the
// same way: what was expected, and what the tree actually carries.
function failOnSetDrift(where, what, actual, wanted) {
  const got = [...actual].sort();
  const expected = [...wanted].sort();
  if (got.join(" ") === expected.join(" ")) return;
  failures.push(
    `${where}: ${what}; expected ${expected.join(", ") || "none"}, got ${got.join(", ") || "none"}`,
  );
}

// Static, dynamic, re-export, and bare side-effect imports all name a module.
// Missing any one form would let a violating import in through that keyword.
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function importSpecifiers(text) {
  const found = [];
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    found.push({ specifier: match[1], index: match.index });
  }
  return found;
}

// The package a specifier addresses, ignoring any subpath export.
function packageRoot(specifier) {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return parts[0];
}

// ─── Shared source rules ──────────────────────────────────────────────────

function checkSourceFile(file) {
  const text = fs.readFileSync(file, "utf8");

  for (const match of text.matchAll(/export\s+\*\s+from\s+["'][^"']+["']/g)) {
    fail(file, lineAt(text, match.index), "wildcard export is not allowed");
  }

  for (const match of text.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']#core["']/g,
  )) {
    const names = match[1];
    if (
      /\b(DbTag|EncryptionTag|ConnectionTag|ConnectionManagerTag|AgentEndpointResolverTag|NetworkSendServiceTag|AuthServiceTag|AppAuthServiceTag|AppEndpointRegistryTag|ContactsServiceTag|ConversationServiceTag|PresenceServiceTag|LeaseRegistryTag|DispatchAdmissionServiceTag|MessageServiceTag|TaskAuthorizationServiceTag|TaskServiceTag)\b/.test(
        names,
      )
    ) {
      fail(
        file,
        lineAt(text, match.index),
        "domain/socket/db service tags must import from their owning barrel, not #core",
      );
    }
  }

  // Final code has neither compatibility package names nor imports of a
  // retired product package. Scanning every current package prevents a
  // consumer from hiding a removed dependency behind a deep subpath.
  for (const { specifier, index } of importSpecifiers(text)) {
    const root = packageRoot(specifier);
    if (root.startsWith("@moltzap/v2-") || RETIRED_PACKAGE_NAMES.has(root)) {
      fail(
        file,
        lineAt(text, index),
        `removed product package import "${root}"`,
      );
    }
  }
}

const sourceFiles = walk(packagesRoot);
if (sourceFiles.length === 0) {
  failures.push(
    "packages/: no TypeScript sources scanned; shared rules would pass vacuously",
  );
}
for (const file of sourceFiles) checkSourceFile(file);

// ─── Retired Client process and test planes ───────────────────────────────

const clientRoot = path.join(packagesRoot, "client");
const retiredClientPaths = [
  "scripts/generate-cli-docs.helpers.ts",
  "scripts/generate-cli-docs.ts",
  "src/__tests__/scripts/generate-cli-docs.test.ts",
  "src/__tests__/service/context",
  "src/__tests__/service/core",
  "src/__tests__/service/history",
  "src/__tests__/service/socket",
  "src/__tests__/support",
  "src/__tests__/vitest-provided.d.ts",
  "src/cli",
  "src/local-daemon-rpc.ts",
  "src/local-history.ts",
  "src/local-socket-server.ts",
  "src/service-local-daemon.ts",
  "src/service-socket-path.test.ts",
  "vitest.integration.globalSetup.ts",
];
const retiredClientWorkspacePaths = [
  "SKILL.md",
  "docs/cli",
  "docs/snippets/cli-commands-table.mdx",
  "docs/snippets/cli-global-flags.mdx",
  "docs/snippets/install-cli.mdx",
];
const clientReferenceFiles = [
  ".github/workflows/ci.yml",
  ".github/workflows/publish.yml",
  "docs/docs.json",
  "knip.json",
  "nx.json",
  "packages/client/package.json",
  "tools/workspace/project.json",
];
const retiredClientReferenceFragments = [
  "dist/cli/index.js",
  "docs/cli",
  "generate-cli-docs",
  "local-daemon-rpc",
  "local-socket-server",
  "service-local-daemon",
];
const retiredClientDependencies = [
  "@effect/cli",
  "@effect/printer",
  "@effect/printer-ansi",
  "@effect/typeclass",
];
const retiredClientTestFragments = ["testPgHost"];

const clientSources = walk(path.join(clientRoot, "src"));
if (clientSources.length === 0) {
  failures.push(
    "packages/client/src: no TypeScript sources scanned; retired-plane checks would pass vacuously",
  );
}
for (const retiredPath of retiredClientPaths) {
  const candidate = path.join(clientRoot, retiredPath);
  const exists =
    fs.existsSync(candidate) &&
    (fs.statSync(candidate).isFile() || directoryContainsFile(candidate));
  if (exists) {
    failures.push(`packages/client/${retiredPath}: retired Client artifact`);
  }
}
for (const retiredPath of retiredClientWorkspacePaths) {
  const candidate = path.join(repo, retiredPath);
  const exists =
    fs.existsSync(candidate) &&
    (fs.statSync(candidate).isFile() || directoryContainsFile(candidate));
  if (exists) {
    failures.push(`${retiredPath}: retired Client artifact`);
  }
}
for (const file of clientSources) {
  const source = fs.readFileSync(file, "utf8");
  for (const fragment of retiredClientTestFragments) {
    if (source.includes(fragment)) {
      fail(
        file,
        lineAt(source, source.indexOf(fragment)),
        `references retired Client test lane ${fragment}`,
      );
    }
  }
}
for (const referenceFile of clientReferenceFiles) {
  const source = fs.readFileSync(path.join(repo, referenceFile), "utf8");
  for (const fragment of retiredClientReferenceFragments) {
    if (source.includes(fragment)) {
      failures.push(
        `${referenceFile}: references retired Client artifact ${fragment}`,
      );
    }
  }
}

const clientManifest = readJson(path.join(clientRoot, "package.json"));
if (Object.hasOwn(clientManifest.bin ?? {}, "moltzap")) {
  failures.push(
    "packages/client/package.json: retired moltzap executable is present",
  );
}
for (const dependency of retiredClientDependencies) {
  if (Object.hasOwn(clientManifest.dependencies ?? {}, dependency)) {
    failures.push(
      `packages/client/package.json: retired CLI dependency ${dependency} is present`,
    );
  }
}
if (Object.hasOwn(clientManifest.devDependencies ?? {}, "tsx")) {
  failures.push(
    "packages/client/package.json: retired CLI generator runtime tsx is present",
  );
}

// ─── Final package set ────────────────────────────────────────────────

const packageDirs = fs.existsSync(packagesRoot)
  ? fs
      .readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];

failOnSetDrift(
  "packages/",
  "product directories drifted",
  packageDirs,
  FINAL_PACKAGE_DIRS,
);

const v2Dirs = fs.existsSync(v2Root)
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

failOnSetDrift("v2/", "executable package roots remain", v2Dirs, []);

// Architectural numbering helps readers navigate specifications, but it
// obscures domain ownership in executable artifacts. Source and package
// metadata name identity, Registry, router, and Router directly.
const DOCUMENTATION_ONLY_LAYER_NOTATION =
  /(?:^|[^A-Za-z0-9])(?:[Ll][12](?=$|[^a-z0-9])|[Ll]ayer(?:[ _-]?(?:[12]|[Oo]ne|[Tt]wo))(?=$|[^a-z0-9]))/g;

let identityRouterVocabularyFileCount = 0;
for (const dir of ["identity", "router"]) {
  const files = walkNonDocumentationFiles(path.join(packagesRoot, dir));
  if (files.length === 0) {
    failures.push(
      `packages/${dir}: no non-documentation files scanned; the vocabulary rule would pass vacuously here`,
    );
    continue;
  }
  identityRouterVocabularyFileCount += files.length;

  for (const file of files) {
    const relativePath = rel(file);
    if (DOCUMENTATION_ONLY_LAYER_NOTATION.test(relativePath)) {
      failures.push(
        `${relativePath}: numbered architecture notation is documentation-only`,
      );
    }
    DOCUMENTATION_ONLY_LAYER_NOTATION.lastIndex = 0;

    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(DOCUMENTATION_ONLY_LAYER_NOTATION)) {
      fail(
        file,
        lineAt(text, match.index),
        "numbered architecture notation is documentation-only; name the owning domain",
      );
    }
  }
}

// ─── Compatibility value ──────────────────────────────────────────────────

const compatibilityVersionFile = path.join(v2Root, "VERSION");
let compatibilityVersion = null;
if (!fs.existsSync(compatibilityVersionFile)) {
  failures.push(
    "v2/VERSION: missing; it is the current MoltZap wire compatibility value",
  );
} else {
  compatibilityVersion = fs
    .readFileSync(compatibilityVersionFile, "utf8")
    .trim();
  if (!/^\d{4}\.\d{3,4}\.\d+$/.test(compatibilityVersion)) {
    failures.push(
      `v2/VERSION: "${compatibilityVersion}" is not a YYYY.MDD.PATCH CalVer`,
    );
  }
}

// ─── Final manifests, references, targets, and Knip roots ────────────────────

const knipWorkspaces = readJson(path.join(repo, "knip.json")).workspaces ?? {};
const workspacePackageNames = new Set();
for (const dir of FINAL_PACKAGE_DIRS) {
  const manifestPath = path.join(packagesRoot, dir, "package.json");
  if (fs.existsSync(manifestPath)) {
    workspacePackageNames.add(readJson(manifestPath).name);
  }
}
failOnSetDrift(
  "packages/*/package.json",
  "workspace package names drifted",
  workspacePackageNames,
  FINAL_PACKAGE_NAMES,
);
failOnSetDrift(
  "knip.json",
  "package workspace roots drifted",
  Object.keys(knipWorkspaces).filter((name) => name.startsWith("packages/")),
  FINAL_PACKAGE_DIRS.map((dir) => `packages/${dir}`),
);

const rootTsconfig = readJson(path.join(repo, "tsconfig.json"));
failOnSetDrift(
  "tsconfig.json",
  "root project references drifted",
  (rootTsconfig.references ?? []).map(({ path: referencePath }) =>
    path.normalize(referencePath),
  ),
  FINAL_PACKAGE_DIRS.map((dir) => path.join("packages", dir)),
);

const workspaceProject = readJson(
  path.join(repo, "tools", "workspace", "project.json"),
);
const workspaceLintDependencies =
  workspaceProject.targets?.lint?.dependsOn?.filter(
    (dependency) => typeof dependency === "string",
  ) ?? [];
if (!workspaceLintDependencies.includes("lint:effect")) {
  failures.push(
    "tools/workspace/project.json: workspace:lint must depend on workspace:lint:effect",
  );
}
const rootManifest = readJson(path.join(repo, "package.json"));
if (rootManifest.scripts?.lint !== "pnpm nx run workspace:lint") {
  failures.push(
    'package.json: lint must route through "pnpm nx run workspace:lint"',
  );
}

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

for (const [dir, expected] of Object.entries(FINAL_PACKAGES)) {
  const where = `packages/${dir}/package.json`;
  const manifest = readJson(path.join(packagesRoot, dir, "package.json"));
  const projectPath = path.join(packagesRoot, dir, "project.json");
  const project = fs.existsSync(projectPath) ? readJson(projectPath) : null;

  if (manifest.name !== expected.npmName) {
    failures.push(
      `${where}: name is "${manifest.name}", expected "${expected.npmName}"`,
    );
  }
  if (project !== null && project.name !== expected.npmName) {
    failures.push(
      `packages/${dir}/project.json: name is "${project.name}", expected "${expected.npmName}"`,
    );
  }

  // Identity and Router are private clean-slate packages. Publication choices
  // for the retained production packages remain deliberately unsettled.
  if ((dir === "identity" || dir === "router") && manifest.private !== true) {
    failures.push(
      `${where}: must stay private until release policy is admitted`,
    );
  }

  const actualExports = manifest.exports ?? {};
  failOnSetDrift(
    where,
    "exports drifted",
    Object.keys(actualExports),
    Object.keys(expected.exports),
  );
  for (const [subpath, wantedTarget] of Object.entries(expected.exports)) {
    const actualTarget = actualExports[subpath];
    for (const condition of ["types", "import"]) {
      if (actualTarget?.[condition] !== wantedTarget[condition]) {
        failures.push(
          `${where}: export "${subpath}" ${condition} target is "${actualTarget?.[condition] ?? "missing"}", expected "${wantedTarget[condition]}"`,
        );
      }
    }
  }
  const rootExport = expected.exports["."];
  if (
    rootExport !== undefined &&
    (manifest.main !== rootExport.import || manifest.types !== rootExport.types)
  ) {
    failures.push(
      `${where}: main/types must match the root export (${rootExport.import}, ${rootExport.types})`,
    );
  }

  const actualBin = manifest.bin ?? {};
  failOnSetDrift(
    where,
    "binaries drifted",
    Object.keys(actualBin),
    Object.keys(expected.bin),
  );

  // Binaries are checked in rather than built, so the target exists at
  // install time and a declared binary is never a dangling link.
  for (const [name, target] of Object.entries(expected.bin)) {
    if (actualBin[name] !== target) {
      failures.push(
        `${where}: binary "${name}" points at "${actualBin[name] ?? "missing"}", expected "${target}"`,
      );
      continue;
    }
    const binPath = path.join(packagesRoot, dir, target);
    if (!fs.existsSync(binPath)) {
      failures.push(
        `${where}: binary "${name}" points at missing file "${target}"`,
      );
      continue;
    }
    if (!fs.readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env node")) {
      failures.push(`${where}: binary "${name}" lacks a node shebang`);
    }
    if ((fs.statSync(binPath).mode & 0o111) === 0) {
      failures.push(`${where}: binary "${name}" is not executable`);
    }
  }

  const wantedDeps = expected.deps.map(
    (dependency) => FINAL_PACKAGES[dependency].npmName,
  );
  const productionMoltZapDependencies = new Set();
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (name.startsWith("@moltzap/")) productionMoltZapDependencies.add(name);
    }
  }
  failOnSetDrift(
    where,
    "production dependencies violate the final DAG",
    productionMoltZapDependencies,
    wantedDeps,
  );
  for (const dependency of wantedDeps) {
    if (manifest.dependencies?.[dependency] !== "workspace:*") {
      failures.push(
        `${where}: final dependency "${dependency}" must be declared as "workspace:*"`,
      );
    }
  }
  for (const section of DEPENDENCY_SECTIONS) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (
        name.startsWith("@moltzap/") &&
        (!FINAL_PACKAGE_NAMES.has(name) || !wantedDeps.includes(name))
      ) {
        failures.push(
          `${where}: ${section} contains forbidden product edge "${name}"`,
        );
      }
    }
  }

  // Project references use normalized paths relative to packages/, so a path
  // that merely ends in an allowed directory name cannot escape the graph.
  const tsconfigPath = path.join(packagesRoot, dir, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    failures.push(`packages/${dir}/tsconfig.json: missing`);
  } else {
    failOnSetDrift(
      `packages/${dir}/tsconfig.json`,
      "project references violate the final DAG",
      (readJson(tsconfigPath).references ?? []).map(({ path: referencePath }) =>
        path.relative(
          packagesRoot,
          path.resolve(path.join(packagesRoot, dir), referencePath),
        ),
      ),
      expected.deps,
    );
  }

  const declaredTargets = new Set([
    ...Object.keys(manifest.nx?.targets ?? {}),
    ...Object.keys(manifest.scripts ?? {}),
    ...Object.keys(project?.targets ?? {}),
  ]);
  const missingDeclaredTargets = expected.targets.filter(
    (target) => !declaredTargets.has(target),
  );
  if (missingDeclaredTargets.length > 0) {
    failures.push(
      `${where}: required Nx target declarations are missing: ${missingDeclaredTargets.join(", ")}`,
    );
  }

  // Knip ignores describe dependencies reached outside its static TypeScript
  // graph, such as an executable launched by path. Source-visible imports need
  // no ignore, so only validate that every ignore is declared and that an
  // ignored product package belongs to the final DAG.
  const ignoredDependencies =
    knipWorkspaces[`packages/${dir}`]?.ignoreDependencies ?? [];
  const declaredDependencies = new Set(
    DEPENDENCY_SECTIONS.flatMap((section) =>
      Object.keys(manifest[section] ?? {}),
    ),
  );
  const undeclaredIgnores = ignoredDependencies.filter(
    (name) => !declaredDependencies.has(name),
  );
  if (undeclaredIgnores.length > 0) {
    failures.push(
      `knip.json workspaces["packages/${dir}"]: ignored dependencies are not declared by ${where}: ${undeclaredIgnores.join(", ")}`,
    );
  }
  const disallowedIgnoredWorkspaceDependencies = ignoredDependencies.filter(
    (name) => name.startsWith("@moltzap/") && !wantedDeps.includes(name),
  );
  if (disallowedIgnoredWorkspaceDependencies.length > 0) {
    failures.push(
      `knip.json workspaces["packages/${dir}"]: ignored product dependencies violate the final DAG: ${disallowedIgnoredWorkspaceDependencies.join(", ")}`,
    );
  }
}

// ─── Final import rules ───────────────────────────────────────────────

const packageByNpmName = new Map(
  Object.values(FINAL_PACKAGES).map((contract) => [contract.npmName, contract]),
);

function exportSubpath(specifier, root) {
  return specifier === root ? "." : `.${specifier.slice(root.length)}`;
}

const SHARED_PACKAGE_CONFIG_IMPORTS = new Set([
  path.join(repo, "eslint.shared.mjs"),
  path.join(repo, "vitest.workspace-aliases.js"),
]);

let finalSourceCount = 0;
for (const [dir, expected] of Object.entries(FINAL_PACKAGES)) {
  const packageDirectory = path.join(packagesRoot, dir);
  const files = walkCodeFiles(packageDirectory);
  if (files.length === 0) {
    failures.push(
      `packages/${dir}: no code files scanned; import rules would pass vacuously here`,
    );
    continue;
  }
  finalSourceCount += files.length;

  const allowedWorkspacePackages = new Set([
    expected.npmName,
    ...expected.deps.map((dependency) => FINAL_PACKAGES[dependency].npmName),
  ]);

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const { specifier, index } of importSpecifiers(text)) {
      const root = packageRoot(specifier);
      if (root.startsWith("@moltzap/")) {
        if (
          root.startsWith("@moltzap/v2-") ||
          RETIRED_PACKAGE_NAMES.has(root)
        ) {
          fail(
            file,
            lineAt(text, index),
            `removed product package import "${root}"`,
          );
          continue;
        }
        if (!FINAL_PACKAGE_NAMES.has(root)) {
          fail(
            file,
            lineAt(text, index),
            `unknown MoltZap package import "${root}"`,
          );
          continue;
        }
        if (!allowedWorkspacePackages.has(root)) {
          fail(
            file,
            lineAt(text, index),
            `dependency DAG violation: "${dir}" may not import "${root}"`,
          );
          continue;
        }
        const subpath = exportSubpath(specifier, root);
        if (!Object.hasOwn(packageByNpmName.get(root).exports, subpath)) {
          fail(
            file,
            lineAt(text, index),
            `import "${specifier}" is not a public export of "${root}"`,
          );
        }
        if (
          (dir === "openclaw-channel" || dir === "nanoclaw-channel") &&
          root === "@moltzap/client" &&
          subpath !== "."
        ) {
          fail(
            file,
            lineAt(text, index),
            "runtime adapter must import only the @moltzap/client root",
          );
        }
      }
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), specifier);
        if (
          !SHARED_PACKAGE_CONFIG_IMPORTS.has(resolved) &&
          resolved !== packageDirectory &&
          !resolved.startsWith(`${packageDirectory}${path.sep}`)
        ) {
          fail(
            file,
            lineAt(text, index),
            `package must not cross its boundary by relative path ("${specifier}")`,
          );
        }
      }
    }
  }
}

// The resolved Nx graph is supplied by CI. Keeping Nx invocation outside this
// script avoids starting Nx recursively when the same checks run as an Nx
// target, while still comparing the graph Nx actually calculated.
function checkNxGraph(graphFile) {
  const parsed = readJson(graphFile);
  const graph = parsed.graph;
  if (graph === undefined || graph.nodes === undefined) {
    failures.push(`${rel(graphFile)}: not an Nx project graph`);
    return;
  }

  failOnSetDrift(
    rel(graphFile),
    "Nx project nodes drifted",
    Object.keys(graph.nodes),
    [...FINAL_PACKAGE_NAMES, "workspace"],
  );

  for (const [dir, expected] of Object.entries(FINAL_PACKAGES)) {
    const node = graph.nodes[expected.npmName];
    if (node === undefined) {
      failures.push(
        `${rel(graphFile)}: missing Nx project "${expected.npmName}"`,
      );
      continue;
    }
    if (node.data?.root !== `packages/${dir}`) {
      failures.push(
        `${rel(graphFile)}: Nx project "${expected.npmName}" root is "${node.data?.root ?? "missing"}", expected "packages/${dir}"`,
      );
    }

    const resolvedTargets = Object.keys(node.data?.targets ?? {});
    const missingTargets = expected.targets.filter(
      (target) => !resolvedTargets.includes(target),
    );
    if (missingTargets.length > 0) {
      failures.push(
        `${rel(graphFile)}: Nx project "${expected.npmName}" is missing required targets: ${missingTargets.join(", ")}`,
      );
    }

    const dependencyEntries = graph.dependencies?.[expected.npmName];
    if (!Array.isArray(dependencyEntries)) {
      failures.push(
        `${rel(graphFile)}: Nx dependency entry for "${expected.npmName}" is missing`,
      );
      continue;
    }
    failOnSetDrift(
      rel(graphFile),
      `Nx dependencies for "${expected.npmName}" violate the final DAG`,
      dependencyEntries.map(({ target }) => target),
      expected.deps.map((dependency) => FINAL_PACKAGES[dependency].npmName),
    );
  }

  const workspaceNode = graph.nodes.workspace;
  if (workspaceNode?.data?.root !== "tools/workspace") {
    failures.push(
      `${rel(graphFile)}: Nx project "workspace" root is "${workspaceNode?.data?.root ?? "missing"}", expected "tools/workspace"`,
    );
  }
  for (const target of [
    "lint",
    "lint:architecture-boundaries",
    "lint:effect",
    "test:integration",
  ]) {
    if (!Object.hasOwn(workspaceNode?.data?.targets ?? {}, target)) {
      failures.push(
        `${rel(graphFile)}: Nx project "workspace" is missing required target "${target}"`,
      );
    }
  }
  failOnSetDrift(
    rel(graphFile),
    'Nx dependencies for "workspace" drifted',
    (graph.dependencies?.workspace ?? []).map(({ target }) => target),
    [],
  );
}

const nxGraphArgument = process.argv.indexOf("--nx-graph");
if (nxGraphArgument !== -1) {
  const graphFile = process.argv[nxGraphArgument + 1];
  if (graphFile === undefined) {
    failures.push("--nx-graph requires a project-graph JSON path");
  } else if (!fs.existsSync(graphFile)) {
    failures.push(`${graphFile}: Nx project graph does not exist`);
  } else {
    checkNxGraph(path.resolve(graphFile));
  }
}

// ─── The compatibility value is exported, and matches ─────────────────────

const identityIndex = path.join(packagesRoot, "identity", "src", "index.ts");
const identityVersion = path.join(
  packagesRoot,
  "identity",
  "src",
  "version.ts",
);
if (compatibilityVersion !== null) {
  if (!fs.existsSync(identityIndex)) {
    failures.push(
      "packages/identity/src/index.ts: missing; it exports the compatibility value",
    );
  } else {
    const reExport = fs
      .readFileSync(identityIndex, "utf8")
      .match(
        /export\s*\{\s*MOLTZAP_VERSION\s*\}\s*from\s*["']\.\/version\.js["']/,
      );
    if (reExport === null) {
      failures.push(
        "packages/identity/src/index.ts: must re-export MOLTZAP_VERSION from ./version.js",
      );
    }
  }
  if (!fs.existsSync(identityVersion)) {
    failures.push(
      "packages/identity/src/version.ts: missing; it owns the compatibility value",
    );
  } else {
    const match = fs
      .readFileSync(identityVersion, "utf8")
      .match(/export\s+const\s+MOLTZAP_VERSION\s*=\s*["']([^"']+)["']/);
    if (match === null) {
      failures.push(
        "packages/identity/src/version.ts: must export the literal MOLTZAP_VERSION",
      );
    } else if (match[1] !== compatibilityVersion) {
      failures.push(
        `packages/identity/src/version.ts: MOLTZAP_VERSION "${match[1]}" does not match v2/VERSION "${compatibilityVersion}"`,
      );
    }
  }
}

// ─── Report ───────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error("[check-architecture-boundaries] FAIL");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `[check-architecture-boundaries] OK — ${sourceFiles.length} package TypeScript sources, ${finalSourceCount} final-package code files, exact seven-product static graph, no executable v2 package roots, and ${identityRouterVocabularyFileCount} Identity/Router non-documentation files scanned at compatibility version ${compatibilityVersion}`,
);
