/**
 * @file Proves the packed `@moltzap/client` exposes exactly its public entry
 * points and executable, keeps its root entry inside the host import
 * allowlists, and imports cleanly from an isolated consumer.
 */
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Archives,
  extractPackedArchive,
  type GateError,
  type GateServices,
  installPackedConsumer,
  type PackedManifest,
  PackGateError,
  packWorkspaceClosure,
  readText,
  requireCondition,
  runCommand,
  runGate,
} from "./test/packed-workspace.ts";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspacePackageRoots = {
  "@moltzap/client": join(workspaceRoot, "packages", "client"),
  "@moltzap/identity": join(workspaceRoot, "packages", "identity"),
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
};

/**
 * Package-relative modules the packed root entry may load. Hosts import the
 * root, so anything else it reaches statically, such as the inbox, the SQLite
 * store, the engine, the collective operation layer, wire signing and
 * verification, or the service, fails the check until it is reviewed and
 * added here.
 */
const hostModules: ReadonlySet<string> = new Set([
  "dist/delivery/history-export.js",
  "dist/delivery/operations.js",
  "dist/endpoint/harness-endpoint/capability.js",
  "dist/endpoint/harness-endpoint/events.js",
  "dist/endpoint/harness-endpoint/index.js",
  "dist/endpoint/implementation.js",
  "dist/endpoint/mcp/names.js",
  "dist/firewall/runtime.js",
  "dist/index.js",
  "dist/store/types.js",
  "dist/transport/collectives/forms.js",
  "dist/transport/collectives/inbound.js",
  "dist/transport/collectives/message-text.js",
  "dist/transport/collectives/render.js",
  "dist/transport/messaging/errors.js",
  "dist/transport/messaging/message.js",
  "dist/transport/wire/values.js",
  "package.json",
]);

/**
 * Bare specifiers the packed root entry may import, matched exactly, so a
 * package subpath such as a Router or Registry server entry fails the check.
 */
const hostPackages: ReadonlySet<string> = new Set([
  "@effect/platform",
  "@modelcontextprotocol/client",
  "@moltzap/identity",
  "canonicalize",
  "effect",
  "node:crypto",
]);

/**
 * Patterns for the module specifiers a built module loads. They match a
 * static import or re-export that is not type-only, a bare side-effect
 * import, and a literal dynamic import.
 */
const importPatterns: readonly RegExp[] = [
  // eslint-disable-next-line sonarjs/slow-regex -- input is this repository's own emitted `dist/` JavaScript, not untrusted text
  /^(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gmu,
  /^import\s+["']([^"']+)["']/gmu,
  /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
];
const unresolvableLoad = /\bimport\(\s*[^"'\s]|\bcreateRequire\b|\brequire\(/u;

/** Every package in the Client closure publishes. */
const publishedPackages: ReadonlySet<string> = new Set(
  Object.keys(workspacePackageRoots),
);

/** A packed consumer composes English and code middleware without a live provider. */
const policyConsumerCheck = `
const { Effect, Layer, Schema } = await import("effect");
const decodeAuditLine = Schema.decodeUnknownSync(Schema.parseJson(service.FirewallAuditRecord));
const auditStart = decodeAuditLine(JSON.stringify({
  kind: "start", format: "moltzap.firewall-audit/v1", snapshotId: "a".repeat(64),
  startedAt: "2026-10-17T00:00:00.000Z",
}));
const auditComplete = decodeAuditLine(JSON.stringify({
  kind: "complete", format: "moltzap.firewall-audit/v1", snapshotId: auditStart.snapshotId,
  checkCount: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
}));
if (auditComplete.kind !== "complete" || auditComplete.snapshotId !== auditStart.snapshotId) {
  throw new Error("Client operator audit decoder lost snapshot identity");
}
const english = await Effect.runPromise(service.makeEnglishPolicy({
  id: "owner",
  rules: [{ id: "privacy", kind: "safety", text: "Do not disclose unrelated private appointments." }],
  provider: {
    decide: () => Effect.fail(new service.DecisionProviderError({
      reason: "transport",
    })),
  },
  settings: {
    minimumProbability: 0.5,
    maximumRequestBytes: 60000,
    timeoutMilliseconds: 1000,
  },
}));
const code = {
  id: "code", revision: "v1", rules: [{ id: "local", kind: "safety" }],
  check: () => Effect.succeed({ findings: [{ ruleId: "local", outcome: "pass" }], expectations: [] }),
};
const firewall = await Effect.runPromise(service.makeFirewall({
  incoming: [code], outgoing: [code, english],
  settings: { timeoutMilliseconds: 10000, middlewareTimeoutMilliseconds: 5000,
    maximumInputBytes: 60000, maximumResultBytes: 100000 },
}));
const message = {
    id: "draft",
    sender: "organizer",
    recipients: ["participant"],
    text: "Are you free Tuesday?",
};
const context = {
  agentId: "organizer", principal: "owner", participants: [],
  history: [],
  facts: [],
  gaps: [],
  authorization: { kind: "absent" },
};
const assessment = await Effect.runPromise(firewall.checkOutgoing(message, context));
if (assessment.judgment !== "hold" ||
    assessment.reason !== "check-unavailable") {
  throw new Error("Client policy assessment did not hold an unavailable check");
}
const incoming = { ...message, sender: "participant", recipients: ["organizer"] };
const received = await Effect.runPromise(firewall.checkIncoming(incoming, context));
if (received.judgment !== "allow") {
  throw new Error("Client code middleware could not admit an incoming message");
}
const invalidInstallation = service.MoltZapService.withFirewall({
  mode: "enforcement", incoming: [], outgoing: [], facts: [], codeDigest: "0".repeat(64),
  auditExport: "/operator/private/firewall-audit.ndjson",
  settings: { timeoutMilliseconds: 10000, middlewareTimeoutMilliseconds: 5000,
    maximumInputBytes: 60000, maximumResultBytes: 100000 },
});
const startupError = await Effect.runPromise(
  Effect.scoped(Layer.build(invalidInstallation)).pipe(Effect.flip),
);
if (!(startupError instanceof service.MoltZapService.StartupError) ||
    startupError.phase !== "configuration") {
  throw new Error("Invalid firewall installation did not stop daemon startup");
}
`;

runGate("moltzap-client-pack-", (temporaryRoot) =>
  Effect.gen(function* () {
    const { archives, manifests } = yield* packWorkspaceClosure(
      workspacePackageRoots,
      temporaryRoot,
      publishedPackages,
    );
    const archive = archives["@moltzap/client"];
    const manifest = manifests["@moltzap/client"];
    const effectDependency = manifest?.dependencies?.effect;
    if (
      archive === undefined ||
      manifest === undefined ||
      effectDependency === undefined
    ) {
      return yield* new PackGateError({
        message: "client package or Effect dependency is missing",
      });
    }
    const publicSpecifiers = yield* verifyPackedManifest(
      archive,
      manifest,
      temporaryRoot,
    );
    yield* verifyConsumerImports(
      archives,
      publicSpecifiers,
      temporaryRoot,
      effectDependency,
    );
    return "client package consumer check passed";
  }),
);

function verifyPackedManifest(
  archive: string,
  manifest: PackedManifest,
  temporaryRoot: string,
): Effect.Effect<readonly string[], GateError, GateServices> {
  return Effect.gen(function* () {
    const extractedPackage = yield* extractPackedArchive(
      archive,
      temporaryRoot,
    );
    const daemonTarget = manifest.bin?.moltzapd;
    yield* requireCondition(
      daemonTarget === "./bin/moltzapd",
      "packed client does not expose the moltzapd executable",
    );
    const exportEntries = Object.entries(manifest.exports ?? {});
    yield* requireCondition(
      exportEntries.length === 2 &&
        exportEntries.some(([subpath]) => subpath === ".") &&
        exportEntries.some(([subpath]) => subpath === "./service"),
      "packed client must expose exactly the root and ./service entrypoints",
    );
    yield* verifyExportTargets(extractedPackage, manifest, exportEntries);
    yield* verifyHostImportGraph(extractedPackage, String(manifest.main));
    yield* verifyDaemon(join(extractedPackage, "bin", "moltzapd"));
    return exportEntries.map(([subpath]) =>
      subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`,
    );
  });
}

function collectExportTargets(value: unknown): readonly unknown[] {
  if (typeof value === "string") {
    return [value];
  }
  return value !== null && typeof value === "object"
    ? Object.values(value).flatMap((nested) => collectExportTargets(nested))
    : [];
}

function verifyExportTargets(
  extractedPackage: string,
  manifest: PackedManifest,
  exportEntries: ReadonlyArray<readonly [string, unknown]>,
): Effect.Effect<void, GateError, FileSystem.FileSystem> {
  const targets = new Set([
    manifest.main,
    manifest.types,
    ...exportEntries.flatMap(([, value]) => collectExportTargets(value)),
  ]);
  return Effect.forEach(
    targets,
    (target) =>
      typeof target === "string" && target.startsWith("./")
        ? readText(
            join(extractedPackage, target),
            `packed client is missing export target ${target}`,
          )
        : requireCondition(
            false,
            `packed client has an invalid export target: ${String(target)}`,
          ),
    { concurrency: 1, discard: true },
  );
}

function verifyDaemon(
  daemonPath: string,
): Effect.Effect<void, GateError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const daemon = yield* readText(
      daemonPath,
      "packed moltzapd executable is missing",
    );
    yield* requireCondition(
      daemon.startsWith("#!/usr/bin/env node\n"),
      "packed moltzapd executable has no Node shebang",
    );
    const info = yield* fs.stat(daemonPath);
    yield* requireCondition(
      (info.mode & 0o111) !== 0,
      "packed moltzapd executable is not executable",
    );
  });
}

/**
 * Fail when the packed root entry reaches a module or package outside the
 * host allowlists, through a static or literal dynamic import, or loads a
 * module it names only at run time.
 * @param extractedPackage Directory of the unpacked client archive.
 * @param entry Package-relative path of the root entry module.
 */
function verifyHostImportGraph(
  extractedPackage: string,
  entry: string,
): Effect.Effect<void, GateError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const seen = new Set<string>();
    const pending = [resolve(extractedPackage, entry)];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (!seen.has(file)) {
        seen.add(file);
        pending.push(...(yield* hostModuleImports(extractedPackage, file)));
      }
    }
  });
}

/**
 * Check one reachable module and return the package-relative files it
 * imports.
 * @param extractedPackage Directory of the unpacked client archive.
 * @param file Absolute path of the module.
 */
function hostModuleImports(
  extractedPackage: string,
  file: string,
): Effect.Effect<readonly string[], GateError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const module = relative(extractedPackage, file);
    yield* requireCondition(
      hostModules.has(module),
      `client root entry loads ${module}, which is not a host module`,
    );
    const source = yield* readText(
      file,
      `client root entry is missing ${module}`,
    );
    yield* requireCondition(
      !unresolvableLoad.test(source),
      `client root entry loads a module ${module} names only at run time`,
    );
    const specifiers = importPatterns.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1] ?? ""),
    );
    yield* Effect.forEach(
      specifiers.filter((specifier) => !specifier.startsWith(".")),
      (specifier) =>
        requireCondition(
          hostPackages.has(specifier),
          `client root entry imports ${specifier} through ${module}`,
        ),
      { concurrency: 1, discard: true },
    );
    return specifiers
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => resolve(dirname(file), specifier));
  });
}

function verifyConsumerImports(
  archives: Archives,
  publicSpecifiers: readonly string[],
  temporaryRoot: string,
  effectDependency: string,
): Effect.Effect<void, GateError, GateServices> {
  return Effect.gen(function* () {
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      workspaceRoot,
      name: "moltzap-client-packed-consumer",
      archives,
      dependencies: { effect: effectDependency },
    });
    const checkPath = join(consumerRoot, "check.mjs");
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      checkPath,
      publicSpecifiers
        .map((specifier) => `await import(${JSON.stringify(specifier)});`)
        .join("\n") +
        `\nconst root = await import("@moltzap/client");\n` +
        `if (!("HistoryExportRecord" in root)) throw new Error("Client root does not export HistoryExportRecord");\n` +
        `\nconst service = await import("@moltzap/client/service");\n` +
        policyConsumerCheck,
    );
    yield* runCommand(process.execPath, [checkPath], {
      cwd: consumerRoot,
      env: { NODE_PATH: "" },
    });
  });
}
