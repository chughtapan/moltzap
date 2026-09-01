import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const clientRoot = join(workspaceRoot, "packages", "client");
const temporaryRoot = await mkdtemp(join(tmpdir(), "moltzap-client-pack-"));

function requireCondition(condition, detail) {
  if (!condition) {
    throw new Error(detail);
  }
}

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

async function packedTarball() {
  const { stdout } = await exec(
    "pnpm",
    ["pack", "--pack-destination", temporaryRoot],
    { cwd: clientRoot },
  );
  const printed = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  requireCondition(
    printed !== undefined,
    "pnpm pack returned no client archive",
  );
  return resolve(clientRoot, printed);
}

async function verifyPackedManifest(extractedPackage) {
  const manifest = JSON.parse(
    await readFile(join(extractedPackage, "package.json"), "utf8"),
  );
  requireCondition(
    manifest.name === "@moltzap/client",
    "packed client manifest has the wrong package name",
  );
  requireCondition(
    manifest.private === true,
    "packed client must remain private until publication is admitted",
  );
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

async function verifyConsumerImports(extractedPackage, publicSpecifiers) {
  const consumerRoot = join(temporaryRoot, "consumer");
  const packageScope = join(consumerRoot, "node_modules", "@moltzap");
  await mkdir(packageScope, { recursive: true });
  await symlink(extractedPackage, join(packageScope, "client"), "dir");
  await symlink(
    await realpath(join(clientRoot, "node_modules")),
    join(extractedPackage, "node_modules"),
    "dir",
  );
  const checkPath = join(consumerRoot, "check.mjs");
  await writeFile(
    checkPath,
    publicSpecifiers
      .map((specifier) => `await import(${JSON.stringify(specifier)});`)
      .join("\n") +
      `\nconst server = await import("@moltzap/client/server");\n` +
      `if (Object.keys(server).join(",") !== "MoltZapDaemon") throw new Error("unexpected Client server exports");\n` +
      `if (Object.keys(server.MoltZapDaemon).sort().join(",") !== "StartupError,layer") throw new Error("unexpected MoltZapDaemon namespace");\n`,
  );
  await exec(process.execPath, [checkPath], { cwd: consumerRoot });
}

try {
  const tarball = await packedTarball();
  const extractedRoot = join(temporaryRoot, "extracted");
  await mkdir(extractedRoot);
  await exec("tar", ["-xzf", tarball, "-C", extractedRoot]);
  const extractedPackage = join(extractedRoot, "package");
  const publicSpecifiers = await verifyPackedManifest(extractedPackage);
  await verifyConsumerImports(extractedPackage, publicSpecifiers);
  process.stdout.write("client package consumer check passed\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
