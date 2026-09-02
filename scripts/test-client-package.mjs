import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
      exportEntries.some(([subpath]) => subpath === "./server"),
    "packed client must expose exactly the root and ./server entrypoints",
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
      `\nconst server = await import("@moltzap/client/server");\n` +
      `if (Object.keys(server).join(",") !== "MoltZapDaemon") throw new Error("unexpected Client server exports");\n` +
      `if (Object.keys(server.MoltZapDaemon).sort().join(",") !== "StartupError,layer") throw new Error("unexpected MoltZapDaemon namespace");\n`,
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
