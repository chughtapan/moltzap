/**
 * @file Proves the packed `@moltzap/client` exposes exactly its public entry
 * points and executable and imports cleanly from an isolated consumer.
 */
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname, join } from "node:path";
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

/** Every package in the Client closure publishes. */
const publishedPackages: ReadonlySet<string> = new Set(
  Object.keys(workspacePackageRoots),
);

runGate("moltzap-client-pack-", (temporaryRoot) =>
  Effect.gen(function* () {
    const { archives, manifests } = yield* packWorkspaceClosure(
      workspacePackageRoots,
      temporaryRoot,
      publishedPackages,
    );
    const archive = archives["@moltzap/client"];
    const manifest = manifests["@moltzap/client"];
    if (archive === undefined || manifest === undefined) {
      return yield* new PackGateError({ message: "client did not pack" });
    }
    const publicSpecifiers = yield* verifyPackedManifest(
      archive,
      manifest,
      temporaryRoot,
    );
    yield* verifyConsumerImports(archives, publicSpecifiers, temporaryRoot);
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
    if (typeof daemonTarget !== "string") {
      return yield* new PackGateError({
        message: "packed client does not expose the moltzapd executable",
      });
    }
    const exportEntries = Object.entries(manifest.exports ?? {});
    yield* requireCondition(
      exportEntries.length === 2 &&
        exportEntries.some(([subpath]) => subpath === ".") &&
        exportEntries.some(([subpath]) => subpath === "./service"),
      "packed client must expose exactly the root and ./service entrypoints",
    );
    yield* verifyExportTargets(extractedPackage, manifest, exportEntries);
    yield* verifyDaemon(join(extractedPackage, daemonTarget));
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
      daemon.startsWith("#!"),
      "packed moltzapd executable has no interpreter shebang",
    );
    const info = yield* fs.stat(daemonPath);
    yield* requireCondition(
      (info.mode & 0o111) !== 0,
      "packed moltzapd executable is not executable",
    );
  });
}

function verifyConsumerImports(
  archives: Archives,
  publicSpecifiers: readonly string[],
  temporaryRoot: string,
): Effect.Effect<void, GateError, GateServices> {
  return Effect.gen(function* () {
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      workspaceRoot,
      name: "moltzap-client-packed-consumer",
      archives,
    });
    const checkPath = join(consumerRoot, "check.mjs");
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      checkPath,
      `import { registerHooks } from "node:module";\n` +
        `const hooks = registerHooks({ resolve(specifier, context, nextResolve) {\n` +
        `  if (specifier === "node:sqlite") throw new Error("Client root loads daemon-owned SQLite");\n` +
        `  return nextResolve(specifier, context);\n` +
        `} });\n` +
        `const root = await import("@moltzap/client");\n` +
        `hooks.deregister();\n` +
        `if (!("HistoryExportRecord" in root)) throw new Error("Client root does not export HistoryExportRecord");\n` +
        publicSpecifiers
          .filter((specifier) => specifier !== "@moltzap/client")
          .map((specifier) => `await import(${JSON.stringify(specifier)});`)
          .join("\n") +
        `\nconst service = await import("@moltzap/client/service");\n` +
        `if (Object.keys(service).join(",") !== "MoltZapService") throw new Error("unexpected Client service exports");\n` +
        `if (Object.keys(service.MoltZapService).sort().join(",") !== "StartupError,layer") throw new Error("unexpected MoltZapService namespace");\n`,
    );
    yield* runCommand(process.execPath, [checkPath], {
      cwd: consumerRoot,
      env: { NODE_PATH: "" },
    });
  });
}
