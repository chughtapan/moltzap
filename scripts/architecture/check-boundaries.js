#!/usr/bin/env node
/**
 * Architecture boundary checks for both tracks.
 *
 * v1 (`packages/*`) rules cover wildcard exports, barrel discipline, and the
 * published export maps. v2 (`v2/*`) rules cover the frozen package set, the
 * shared compatibility value, the export and binary maps, and the three
 * import rules that keep the clean slate clean.
 *
 * The v2 table below is a hand transcription of frozen law in
 * docs/architecture/components.md. It is written down rather than derived so
 * that drift fails whichever side moves, but it is not self-certifying:
 * re-verify it against that document whenever the document changes.
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

// `deps` lists the only v2 packages a package may reach, in package.json, in
// TypeScript project references, in knip's ignore list, and in source imports
// alike.
const V2_PACKAGES = {
  identity: {
    npmName: "@moltzap/v2-identity",
    deps: [],
    exports: [".", "./server"],
    bin: ["moltzap-registry"],
  },
  router: {
    npmName: "@moltzap/v2-router",
    deps: ["identity"],
    exports: [".", "./server"],
    bin: ["moltzap-router"],
  },
  transcript: {
    npmName: "@moltzap/v2-transcript",
    deps: ["identity", "router"],
    exports: [".", "./server"],
    bin: ["moltzap-ledger"],
  },
  endpoint: {
    npmName: "@moltzap/v2-endpoint",
    deps: ["identity", "router", "transcript"],
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
    deps: ["identity", "router", "transcript", "endpoint", "simulator"],
    exports: ["."],
    bin: [],
  },
};

// Simulator and testbed are experiment and acquisition machinery. The
// packages that ship the product must never reach for them.
const NON_PRODUCTION = ["simulator", "testbed"];
const PRODUCTION = Object.keys(V2_PACKAGES).filter(
  (dir) => !NON_PRODUCTION.includes(dir),
);

const v2DirByNpmName = new Map(
  Object.entries(V2_PACKAGES).map(([dir, meta]) => [meta.npmName, dir]),
);

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

// ─── v1 source rules ──────────────────────────────────────────────────────

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

  // v1 ships the product too, so the no-simulator/testbed rule binds it. The
  // literal guard keeps the common case to one substring scan.
  if (text.includes("@moltzap/v2-")) {
    for (const { specifier, index } of importSpecifiers(text)) {
      const target = v2DirByNpmName.get(packageRoot(specifier));
      if (target !== undefined && NON_PRODUCTION.includes(target)) {
        fail(
          file,
          lineAt(text, index),
          `production package must not import non-production package "${target}"`,
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

function assertBinMap(pkgPath, expected) {
  const pkg = readJson(path.join(repo, pkgPath, "package.json"));
  const bin = pkg.bin ?? {};
  failOnSetDrift(
    `${pkgPath}/package.json`,
    "bin changed",
    typeof bin === "string" ? [path.basename(pkgPath)] : Object.keys(bin),
    expected,
  );
}

// ─── adapter containment ──────────────────────────────────────────────────

// Channel adapters reach MoltZap only through the client's published subpaths,
// and only through the ones that carry adapter-facing contracts. A deep import
// would let an adapter build its own transport beside HarnessClient, which is
// exactly the coexistence this package set removed.
const ADAPTER_PACKAGES = ["openclaw-channel", "nanoclaw-channel"];
// Shipped sources only. Test scaffolding legitimately drives a peer agent and
// registers fixtures against a real server; none of it reaches a user.
const TEST_FILE = /(^|\/)(__tests__\/|vitest\.)|\.test\.ts$|\.test-utils\.ts$/;
const ADAPTER_CLIENT_SUBPATHS = new Set([
  "@moltzap/client",
  "@moltzap/client/channel-base",
  "@moltzap/client/harness-client",
  "@moltzap/client/notification",
  "@moltzap/client/pagination",
  "@moltzap/client/test-utils",
]);
// Daemon-side machinery. Naming these by symbol catches a re-export chain that
// the subpath rule alone would let through.
const DAEMON_ONLY_SYMBOLS =
  /\b(MoltZapService|MoltZapChannelCore|MoltZapAgentClient|ChannelService|acquireMoltzapd|runMoltzapd)\b/;

function checkAdapterFile(file) {
  const text = fs.readFileSync(file, "utf8");

  for (const { specifier, index } of importSpecifiers(text)) {
    if (
      specifier.startsWith("@moltzap/client") &&
      !ADAPTER_CLIENT_SUBPATHS.has(specifier)
    ) {
      fail(
        file,
        lineAt(text, index),
        `adapter may not import "${specifier}"; use a published adapter-facing subpath`,
      );
    }
  }

  for (const match of text.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']*["']/g,
  )) {
    if (DAEMON_ONLY_SYMBOLS.test(match[1])) {
      fail(
        file,
        lineAt(text, match.index),
        "adapter may not import daemon-side machinery; reach MoltZap through HarnessClient",
      );
    }
  }
}

const sourceFiles = walk(packagesRoot);
if (sourceFiles.length === 0) {
  failures.push(
    "packages/: no TypeScript sources scanned; the v1 rules would pass vacuously",
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
assertExportMap("packages/client", [
  ".",
  "./auth",
  "./channel-base",
  "./harness-client",
  "./notification",
  "./pagination",
  "./test-utils",
]);

// The bespoke `moltzap` CLI is gone. Only the daemon ships as a binary.
assertBinMap("packages/client", ["moltzapd"]);
assertBinMap("packages/server", ["moltzap-server"]);

let adapterSourceCount = 0;
for (const adapter of ADAPTER_PACKAGES) {
  const files = walk(path.join(packagesRoot, adapter)).filter(
    (file) => !TEST_FILE.test(rel(file)),
  );
  if (files.length === 0) {
    failures.push(
      `packages/${adapter}: no shipped TypeScript sources scanned; the adapter containment rules would pass vacuously`,
    );
    continue;
  }
  adapterSourceCount += files.length;
  for (const file of files) checkAdapterFile(file);
}

// ─── v2 package set ───────────────────────────────────────────────────────

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

failOnSetDrift("v2/", "package set drifted", v2Dirs, Object.keys(V2_PACKAGES));

// Architectural numbering helps readers navigate specifications, but it
// obscures domain ownership in executable artifacts. Source and package
// metadata name identity, Registry, router, and Router directly.
const DOCUMENTATION_ONLY_LAYER_NOTATION =
  /(?:^|[^A-Za-z0-9])(?:[Ll][12](?=$|[^a-z0-9])|[Ll]ayer(?:[ _-]?(?:[12]|[Oo]ne|[Tt]wo))(?=$|[^a-z0-9]))/g;

let v2VocabularyFileCount = 0;
for (const dir of v2Dirs) {
  const files = walkNonDocumentationFiles(path.join(v2Root, dir));
  if (files.length === 0) {
    failures.push(
      `v2/${dir}: no non-documentation files scanned; the vocabulary rule would pass vacuously here`,
    );
    continue;
  }
  v2VocabularyFileCount += files.length;

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

// ─── One CalVer, carried by v2/VERSION and all six manifests ──────────────

const versionFile = path.join(v2Root, "VERSION");
let v2Version = null;
if (!fs.existsSync(versionFile)) {
  failures.push(
    "v2/VERSION: missing; it is the sole MoltZap compatibility value",
  );
} else {
  v2Version = fs.readFileSync(versionFile, "utf8").trim();
  if (!/^\d{4}\.\d{3,4}\.\d+$/.test(v2Version)) {
    failures.push(`v2/VERSION: "${v2Version}" is not a YYYY.MDD.PATCH CalVer`);
  }
}

// ─── v2 manifests, project references, and knip ignores ───────────────────

const knipWorkspaces = readJson(path.join(repo, "knip.json")).workspaces ?? {};

for (const dir of v2Dirs) {
  const expected = V2_PACKAGES[dir];
  if (expected === undefined) continue;

  const where = `v2/${dir}/package.json`;
  const manifest = readJson(path.join(v2Root, dir, "package.json"));

  if (manifest.name !== expected.npmName) {
    failures.push(
      `${where}: name is "${manifest.name}", expected "${expected.npmName}"`,
    );
  }

  if (v2Version !== null && manifest.version !== v2Version) {
    failures.push(
      `${where}: version "${manifest.version}" does not match v2/VERSION "${v2Version}"`,
    );
  }

  if (manifest.private !== true) {
    failures.push(`${where}: must set "private": true; v2 publishes nothing`);
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
    const binPath = path.join(v2Root, dir, target);
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

  const wantedDeps = expected.deps.map((d) => V2_PACKAGES[d].npmName);
  failOnSetDrift(
    where,
    "v2 dependencies violate the frozen DAG",
    Object.keys(manifest.dependencies ?? {}).filter((name) =>
      v2DirByNpmName.has(name),
    ),
    wantedDeps,
  );

  // Project references must encode the same DAG, or `tsc -b` and the manifest
  // disagree about what this package may reach.
  const tsconfigPath = path.join(v2Root, dir, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    failures.push(`v2/${dir}/tsconfig.json: missing`);
  } else {
    failOnSetDrift(
      `v2/${dir}/tsconfig.json`,
      "project references violate the frozen DAG",
      (readJson(tsconfigPath).references ?? []).map((ref) =>
        path.basename(ref.path),
      ),
      expected.deps,
    );
  }

  // Knip ignores describe dependencies reached outside its static TypeScript
  // graph, such as an executable launched by path. Source-visible imports need
  // no ignore, so only validate that every ignore is declared and that an
  // ignored v2 package belongs to the frozen DAG.
  const ignoredDependencies =
    knipWorkspaces[`v2/${dir}`]?.ignoreDependencies ?? [];
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
      `knip.json workspaces["v2/${dir}"]: ignored dependencies are not declared by ${where}: ${undeclaredIgnores.join(", ")}`,
    );
  }
  const disallowedIgnoredV2Dependencies = ignoredDependencies.filter(
    (name) => v2DirByNpmName.has(name) && !wantedDeps.includes(name),
  );
  if (disallowedIgnoredV2Dependencies.length > 0) {
    failures.push(
      `knip.json workspaces["v2/${dir}"]: ignored v2 dependencies violate the frozen DAG: ${disallowedIgnoredV2Dependencies.join(", ")}`,
    );
  }
}

// ─── v2 import rules ──────────────────────────────────────────────────────

// Workspace packages whose source lives under packages/ are v1. Resolving the
// rule against the real layout keeps it correct however either track names
// its packages.
const v1PackageNames = new Set();
if (fs.existsSync(packagesRoot)) {
  for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    const manifestPath = path.join(packagesRoot, entry.name, "package.json");
    if (entry.isDirectory() && fs.existsSync(manifestPath)) {
      v1PackageNames.add(readJson(manifestPath).name);
    }
  }
}
if (v1PackageNames.size === 0) {
  failures.push(
    "packages/: no v1 workspace manifests found; the v2-imports-no-v1 rule would pass vacuously",
  );
}

let v2SourceCount = 0;
for (const dir of v2Dirs) {
  const files = walk(path.join(v2Root, dir));
  if (files.length === 0) {
    failures.push(
      `v2/${dir}: no TypeScript sources scanned; the import rules would pass vacuously here`,
    );
    continue;
  }
  v2SourceCount += files.length;

  const allowed = new Set(V2_PACKAGES[dir]?.deps ?? []);
  const isProduction = PRODUCTION.includes(dir);

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const { specifier, index } of importSpecifiers(text)) {
      // Rule 1 — v2 imports nothing from v1, by package name or by reaching
      // into the packages/ tree with a relative path.
      const root = packageRoot(specifier);
      if (v1PackageNames.has(root)) {
        fail(
          file,
          lineAt(text, index),
          `v2 must not import v1 package "${root}"`,
        );
        continue;
      }
      if (/(^|\/)\.\.\/packages\//.test(specifier)) {
        fail(
          file,
          lineAt(text, index),
          `v2 must not reach into packages/ by relative path ("${specifier}")`,
        );
        continue;
      }

      const target = v2DirByNpmName.get(root);
      if (target === undefined || target === dir) continue;

      // Rule 2 — nothing that ships the product may import the simulator or
      // the testbed. Checked before the DAG so the violation is named for
      // what it actually is.
      if (isProduction && NON_PRODUCTION.includes(target)) {
        fail(
          file,
          lineAt(text, index),
          `production package "${dir}" must not import non-production package "${target}"`,
        );
        continue;
      }

      // Rule 3 — every remaining cross-package import follows the DAG.
      if (!allowed.has(target)) {
        fail(
          file,
          lineAt(text, index),
          `dependency DAG violation: "${dir}" may not import "${target}" (allowed: ${[...allowed].join(", ") || "none"})`,
        );
      }
    }
  }
}

// ─── The compatibility value is exported, and matches ─────────────────────

const identityIndex = path.join(v2Root, "identity", "src", "index.ts");
const identityVersion = path.join(v2Root, "identity", "src", "version.ts");
if (v2Version !== null) {
  if (!fs.existsSync(identityIndex)) {
    failures.push(
      "v2/identity/src/index.ts: missing; it exports the compatibility value",
    );
  } else {
    const reExport = fs
      .readFileSync(identityIndex, "utf8")
      .match(
        /export\s*\{\s*MOLTZAP_VERSION\s*\}\s*from\s*["']\.\/version\.js["']/,
      );
    if (reExport === null) {
      failures.push(
        "v2/identity/src/index.ts: must re-export MOLTZAP_VERSION from ./version.js",
      );
    }
  }
  if (!fs.existsSync(identityVersion)) {
    failures.push(
      "v2/identity/src/version.ts: missing; it owns the compatibility value",
    );
  } else {
    const match = fs
      .readFileSync(identityVersion, "utf8")
      .match(/export\s+const\s+MOLTZAP_VERSION\s*=\s*["']([^"']+)["']/);
    if (match === null) {
      failures.push(
        "v2/identity/src/version.ts: must export the literal MOLTZAP_VERSION",
      );
    } else if (match[1] !== v2Version) {
      failures.push(
        `v2/identity/src/version.ts: MOLTZAP_VERSION "${match[1]}" does not match v2/VERSION "${v2Version}"`,
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
  `[check-architecture-boundaries] OK — ${sourceFiles.length} v1 sources, ${adapterSourceCount} adapter sources, ${v2Dirs.length} v2 packages, ${v2SourceCount} v2 sources, and ${v2VocabularyFileCount} v2 non-documentation files scanned at version ${v2Version}`,
);
