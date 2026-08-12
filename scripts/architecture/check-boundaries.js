#!/usr/bin/env node
/**
 * Architecture boundary checks during the package cutover.
 *
 * Shared `packages/*` rules cover wildcard exports and barrel discipline.
 * Identity and Router additionally enforce their final package names, public
 * entrypoints, binaries, project references, and dependency direction. Client
 * also pins each retired CLI, Unix-RPC artifact, and server-backed v1 test
 * lane while its final public interface remains gated. The remaining packages
 * stay visible while their cutover lanes retire protocol and server and narrow
 * the adapter, simulator, and eval dependencies.
 *
 * The relocated-package table is a hand transcription of the current package
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

// `deps` lists the only workspace packages each relocated package may reach in
// package.json, TypeScript project references, knip ignores, and source imports.
const RELOCATED_PACKAGES = {
  identity: {
    npmName: "@moltzap/identity",
    deps: [],
    exports: [".", "./registry", "./registry/server"],
    bin: ["moltzap-registry"],
  },
  router: {
    npmName: "@moltzap/router",
    deps: ["identity"],
    exports: [".", "./server"],
    bin: ["moltzap-router"],
  },
};

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
    /import\s*\{([^}]*)\}\s*from\s*["']#transport["']/g,
  )) {
    const names = match[1];
    if (
      /\b(defineRpc|defineNotification|decodeRpcResult|effectiveErrorClasses|jsonRpcMethod)\b/.test(
        names,
      )
    ) {
      fail(
        file,
        lineAt(text, match.index),
        "descriptor construction must import from #transport/descriptor",
      );
    }
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

  // Relocated code has no compatibility package names. Scanning every current
  // package prevents a retiring consumer from keeping a hidden old import.
  if (text.includes("@moltzap/v2-")) {
    for (const { specifier, index } of importSpecifiers(text)) {
      if (packageRoot(specifier).startsWith("@moltzap/v2-")) {
        fail(
          file,
          lineAt(text, index),
          `removed compatibility package import "${packageRoot(specifier)}"`,
        );
      }
    }
  }
}

function assertExportMap(pkgPath, expected) {
  const pkg = readJson(path.join(repo, pkgPath, "package.json"));
  failOnSetDrift(
    `${pkgPath}/package.json`,
    "exports changed",
    Object.keys(pkg.exports ?? {}),
    expected,
  );
}

const sourceFiles = walk(packagesRoot);
if (sourceFiles.length === 0) {
  failures.push(
    "packages/: no TypeScript sources scanned; shared rules would pass vacuously",
  );
}
for (const file of sourceFiles) checkSourceFile(file);

assertExportMap("packages/protocol", [
  ".",
  "./conversation",
  "./identity",
  "./message",
  "./network",
  "./rpc",
  "./socket",
  "./socket/catalog",
  "./testing",
]);
assertExportMap("packages/server", [".", "./test-utils"]);

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
  "vitest.integration.config.mjs",
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
const retiredClientTestFragments = [
  "server-core",
  "testPgHost",
  "vitest.integration",
];

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
const clientTsconfig = readJson(path.join(clientRoot, "tsconfig.json"));
if (Object.hasOwn(clientManifest.bin ?? {}, "moltzap")) {
  failures.push(
    "packages/client/package.json: retired moltzap executable is present",
  );
}
if (Object.hasOwn(clientManifest.scripts ?? {}, "test:integration")) {
  failures.push(
    "packages/client/package.json: retired v1 integration target is present",
  );
}
for (const dependency of retiredClientDependencies) {
  if (Object.hasOwn(clientManifest.dependencies ?? {}, dependency)) {
    failures.push(
      `packages/client/package.json: retired CLI dependency ${dependency} is present`,
    );
  }
}
if (
  Object.hasOwn(clientManifest.dependencies ?? {}, "@moltzap/server-core") ||
  Object.hasOwn(clientManifest.devDependencies ?? {}, "@moltzap/server-core")
) {
  failures.push(
    "packages/client/package.json: retired server-core test dependency is present",
  );
}
if (
  (clientTsconfig.references ?? []).some(
    (reference) => reference.path === "../server",
  )
) {
  failures.push(
    "packages/client/tsconfig.json: retired server project reference is present",
  );
}
if (Object.hasOwn(clientManifest.devDependencies ?? {}, "tsx")) {
  failures.push(
    "packages/client/package.json: retired CLI generator runtime tsx is present",
  );
}

// ─── Relocated package set ────────────────────────────────────────────────

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

let relocatedVocabularyFileCount = 0;
for (const dir of Object.keys(RELOCATED_PACKAGES)) {
  const files = walkNonDocumentationFiles(path.join(packagesRoot, dir));
  if (files.length === 0) {
    failures.push(
      `packages/${dir}: no non-documentation files scanned; the vocabulary rule would pass vacuously here`,
    );
    continue;
  }
  relocatedVocabularyFileCount += files.length;

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

// ─── Relocated manifests, references, and knip ignores ────────────────────

const knipWorkspaces = readJson(path.join(repo, "knip.json")).workspaces ?? {};
const workspacePackageNames = new Set();
for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
  const manifestPath = path.join(packagesRoot, entry.name, "package.json");
  if (entry.isDirectory() && fs.existsSync(manifestPath)) {
    workspacePackageNames.add(readJson(manifestPath).name);
  }
}
if (workspacePackageNames.size === 0) {
  failures.push(
    "packages/: no workspace manifests found; dependency rules would pass vacuously",
  );
}

for (const [dir, expected] of Object.entries(RELOCATED_PACKAGES)) {
  const where = `packages/${dir}/package.json`;
  const manifest = readJson(path.join(packagesRoot, dir, "package.json"));

  if (manifest.name !== expected.npmName) {
    failures.push(
      `${where}: name is "${manifest.name}", expected "${expected.npmName}"`,
    );
  }

  if (manifest.private !== true) {
    failures.push(
      `${where}: must stay private until release policy is admitted`,
    );
  }

  failOnSetDrift(
    where,
    "exports drifted",
    Object.keys(manifest.exports ?? {}),
    expected.exports,
  );
  failOnSetDrift(
    where,
    "binaries drifted",
    Object.keys(manifest.bin ?? {}),
    expected.bin,
  );

  // Binaries are checked in rather than built, so the target exists at
  // install time and a declared binary is never a dangling link.
  for (const [name, target] of Object.entries(manifest.bin ?? {})) {
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
    (dependency) => RELOCATED_PACKAGES[dependency].npmName,
  );
  failOnSetDrift(
    where,
    "workspace dependencies violate the relocated DAG",
    Object.keys(manifest.dependencies ?? {}).filter((name) =>
      workspacePackageNames.has(name),
    ),
    wantedDeps,
  );

  // Project references must encode the same DAG, or `tsc -b` and the manifest
  // disagree about what this package may reach.
  const tsconfigPath = path.join(packagesRoot, dir, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    failures.push(`packages/${dir}/tsconfig.json: missing`);
  } else {
    failOnSetDrift(
      `packages/${dir}/tsconfig.json`,
      "project references violate the relocated DAG",
      (readJson(tsconfigPath).references ?? []).map((ref) =>
        path.basename(ref.path),
      ),
      expected.deps,
    );
  }

  // Knip ignores describe dependencies reached outside its static TypeScript
  // graph, such as an executable launched by path. Source-visible imports need
  // no ignore, so only validate that every ignore is declared and that an
  // ignored workspace package belongs to the relocated DAG.
  const ignoredDependencies =
    knipWorkspaces[`packages/${dir}`]?.ignoreDependencies ?? [];
  const declaredDependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const undeclaredIgnores = ignoredDependencies.filter(
    (name) => !declaredDependencies.has(name),
  );
  if (undeclaredIgnores.length > 0) {
    failures.push(
      `knip.json workspaces["packages/${dir}"]: ignored dependencies are not declared by ${where}: ${undeclaredIgnores.join(", ")}`,
    );
  }
  const disallowedIgnoredWorkspaceDependencies = ignoredDependencies.filter(
    (name) => workspacePackageNames.has(name) && !wantedDeps.includes(name),
  );
  if (disallowedIgnoredWorkspaceDependencies.length > 0) {
    failures.push(
      `knip.json workspaces["packages/${dir}"]: ignored workspace dependencies violate the relocated DAG: ${disallowedIgnoredWorkspaceDependencies.join(", ")}`,
    );
  }
}

// ─── Relocated import rules ───────────────────────────────────────────────

let relocatedSourceCount = 0;
for (const [dir, expected] of Object.entries(RELOCATED_PACKAGES)) {
  const packageDirectory = path.join(packagesRoot, dir);
  const files = walk(packageDirectory);
  if (files.length === 0) {
    failures.push(
      `packages/${dir}: no TypeScript sources scanned; import rules would pass vacuously here`,
    );
    continue;
  }
  relocatedSourceCount += files.length;

  const allowedWorkspacePackages = new Set([
    expected.npmName,
    ...expected.deps.map(
      (dependency) => RELOCATED_PACKAGES[dependency].npmName,
    ),
  ]);

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const { specifier, index } of importSpecifiers(text)) {
      const root = packageRoot(specifier);
      if (
        workspacePackageNames.has(root) &&
        !allowedWorkspacePackages.has(root)
      ) {
        fail(
          file,
          lineAt(text, index),
          `dependency DAG violation: "${dir}" may not import "${root}"`,
        );
        continue;
      }
      if (
        specifier.startsWith(".") &&
        !path
          .resolve(path.dirname(file), specifier)
          .startsWith(`${packageDirectory}${path.sep}`)
      ) {
        fail(
          file,
          lineAt(text, index),
          `relocated package must not cross its boundary by relative path ("${specifier}")`,
        );
      }
    }
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
  `[check-architecture-boundaries] OK — ${sourceFiles.length} package sources, no executable v2 package roots, ${relocatedSourceCount} relocated sources, and ${relocatedVocabularyFileCount} relocated non-documentation files scanned at compatibility version ${compatibilityVersion}`,
);
