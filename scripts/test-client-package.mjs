import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
 * Fail when the packed root entry statically reaches the daemon runtime. Hosts
 * import the root, so it must stay off the inbox, the SQLite store, the engine,
 * the collective operation layer, wire signing and verification, the Router
 * client, and `node:sqlite`.
 * @param {string} extractedPackage Directory of the unpacked client archive.
 * @param {string} entry Package-relative path of the root entry module.
 * @returns {Promise<void>}
 */
async function verifyHostImportGraph(extractedPackage, entry) {
  const daemonOnly =
    /\/(delivery\/(host-delivery|inbox|pass|send-invocations|state)|store\/(index|store)|transport\/messaging\/index|transport\/collectives\/(index|operation)|transport\/wire\/(index|codec|schemas|verification))\.js$/u;
  const importPattern =
    /^(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^import\s+["']([^"']+)["']/gmu;
  const seen = new Set();
  const pending = [resolve(extractedPackage, entry)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    requireCondition(
      !daemonOnly.test(file),
      `client root entry loads daemon module ${file.slice(extractedPackage.length)}`,
    );
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      requireCondition(
        specifier !== "node:sqlite" && specifier !== "@moltzap/router",
        `client root entry loads ${specifier} through ${file.slice(extractedPackage.length)}`,
      );
      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(file), specifier));
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
