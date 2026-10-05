import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  extractPackedArchive,
  installPackedConsumer,
  packWorkspaceClosure,
  requireCondition,
} from "./test/packed-workspace.mjs";

const exec = promisify(execFile);
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspacePackageRoots = Object.freeze({
  "@moltzap/client": join(workspaceRoot, "packages", "client"),
  "@moltzap/identity": join(workspaceRoot, "packages", "identity"),
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
});
const temporaryRoot = await mkdtemp(join(tmpdir(), "moltzap-client-pack-"));

function collectExportTargets(value, targets = []) {
  if (typeof value === "string") {
    targets.push(value);
    return targets;
  }
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      collectExportTargets(nested, targets);
    }
  }
  return targets;
}

async function verifyPackedManifest(archive, manifest) {
  const extractedPackage = await extractPackedArchive(archive, temporaryRoot);
  requireCondition(
    manifest.bin?.moltzapd === "./bin/moltzapd",
    "packed client does not expose the moltzapd executable",
  );
  const exportEntries = Object.entries(manifest.exports ?? {});
  requireCondition(
    exportEntries.length === 2 &&
      exportEntries.some(([subpath]) => subpath === ".") &&
      exportEntries.some(([subpath]) => subpath === "./service"),
    "packed client must expose exactly the root and ./service entrypoints",
  );
  const targets = [manifest.main, manifest.types];
  for (const [, value] of exportEntries) {
    targets.push(...collectExportTargets(value));
  }
  for (const target of new Set(targets)) {
    requireCondition(
      typeof target === "string" && target.startsWith("./"),
      `packed client has an invalid export target: ${String(target)}`,
    );
    await readFile(join(extractedPackage, target)).catch((cause) => {
      throw new Error(`packed client is missing export target ${target}`, {
        cause,
      });
    });
  }
  await verifyHostImportGraph(extractedPackage, manifest.main);
  const daemonPath = join(extractedPackage, manifest.bin.moltzapd);
  const daemon = await readFile(daemonPath, "utf8");
  requireCondition(
    daemon.startsWith("#!/usr/bin/env node\n"),
    "packed moltzapd executable has no Node shebang",
  );
  requireCondition(
    ((await stat(daemonPath)).mode & 0o111) !== 0,
    "packed moltzapd executable is not executable",
  );
  return exportEntries.map(([subpath]) =>
    subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`,
  );
}

/**
 * Package-relative modules the packed root entry may load. Hosts import the
 * root, so anything else it reaches statically, such as the inbox, the SQLite
 * store, the engine, the collective operation layer, wire signing and
 * verification, or the service, fails the check until it is reviewed and
 * added here.
 * @type {ReadonlySet<string>}
 */
const hostModules = new Set([
  "dist/delivery/history-export.js",
  "dist/delivery/operations.js",
  "dist/endpoint/harness-endpoint/capability.js",
  "dist/endpoint/harness-endpoint/events.js",
  "dist/endpoint/harness-endpoint/index.js",
  "dist/endpoint/implementation.js",
  "dist/endpoint/mcp/names.js",
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
 * @type {ReadonlySet<string>}
 */
const hostPackages = new Set([
  "@effect/platform",
  "@modelcontextprotocol/client",
  "@moltzap/identity",
  "canonicalize",
  "effect",
  "node:crypto",
]);

/**
 * Fail when the packed root entry reaches a module or package outside the
 * host allowlists, through a static or literal dynamic import, or loads a
 * module it names only at run time.
 * @param {string} extractedPackage Directory of the unpacked client archive.
 * @param {string} entry Package-relative path of the root entry module.
 * @returns {Promise<void>}
 */
async function verifyHostImportGraph(extractedPackage, entry) {
  const importPattern =
    /^(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gmu;
  const unresolvableLoad =
    /\bimport\(\s*[^"'\s]|\bcreateRequire\b|\brequire\(/u;
  const seen = new Set();
  const pending = [resolve(extractedPackage, entry)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const module = relative(extractedPackage, file);
    requireCondition(
      hostModules.has(module),
      `client root entry loads ${module}, which is not a host module`,
    );
    const source = await readFile(file, "utf8");
    requireCondition(
      !unresolvableLoad.test(source),
      `client root entry loads a module ${module} names only at run time`,
    );
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(file), specifier));
      } else {
        requireCondition(
          hostPackages.has(specifier),
          `client root entry imports ${specifier} through ${module}`,
        );
      }
    }
  }
}

async function verifyConsumerImports(archives, publicSpecifiers) {
  const consumerRoot = await installPackedConsumer({
    temporaryRoot,
    workspaceRoot,
    name: "moltzap-client-packed-consumer",
    archives,
  });
  const checkPath = join(consumerRoot, "check.mjs");
  await writeFile(
    checkPath,
    publicSpecifiers
      .map((specifier) => `await import(${JSON.stringify(specifier)});`)
      .join("\n") +
      `\nconst root = await import("@moltzap/client");\n` +
      `if (!("HistoryExportRecord" in root)) throw new Error("Client root does not export HistoryExportRecord");\n` +
      `\nconst service = await import("@moltzap/client/service");\n` +
      `if (Object.keys(service).join(",") !== "MoltZapService") throw new Error("unexpected Client service exports");\n` +
      `if (Object.keys(service.MoltZapService).sort().join(",") !== "StartupError,layer") throw new Error("unexpected MoltZapService namespace");\n`,
  );
  await exec(process.execPath, [checkPath], {
    cwd: consumerRoot,
    env: { ...process.env, NODE_PATH: undefined },
  });
}

try {
  const { archives, manifests } = await packWorkspaceClosure(
    workspacePackageRoots,
    temporaryRoot,
    // every package in this closure publishes
    new Set(Object.keys(workspacePackageRoots)),
  );
  const publicSpecifiers = await verifyPackedManifest(
    archives["@moltzap/client"],
    manifests["@moltzap/client"],
  );
  await verifyConsumerImports(archives, publicSpecifiers);
  process.stdout.write("client package consumer check passed\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
