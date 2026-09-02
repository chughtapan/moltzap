import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  packWorkspacePackages,
  readPackedManifests,
} from "./test/packed-workspace.mjs";

const exec = promisify(execFile);
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const clientRoot = join(workspaceRoot, "packages", "client");
const workspacePackageRoots = Object.freeze({
  "@moltzap/client": clientRoot,
  "@moltzap/identity": join(workspaceRoot, "packages", "identity"),
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
});
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

async function verifyPackedManifest(extractedPackage) {
  const manifest = JSON.parse(
    await readFile(join(extractedPackage, "package.json"), "utf8"),
  );
  requireCondition(
    manifest.name === "@moltzap/client",
    "packed client manifest has the wrong package name",
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

function localArchiveSpecifier(consumerRoot, archive) {
  return `file:${relative(consumerRoot, archive)}`;
}

async function verifyIsolatedInstall(consumerRoot) {
  const installedRoot = await realpath(consumerRoot);
  for (const packageName of [
    "@moltzap/client",
    "@moltzap/identity",
    "@moltzap/router",
  ]) {
    const installed = await realpath(
      join(consumerRoot, "node_modules", ...packageName.split("/")),
    );
    requireCondition(
      installed.startsWith(`${installedRoot}/`),
      `packed consumer resolved ${packageName} outside its isolated install`,
    );
  }
  const lockfile = await readFile(join(consumerRoot, "pnpm-lock.yaml"), "utf8");
  requireCondition(
    !lockfile.includes(workspaceRoot) &&
      !lockfile.includes("workspace:") &&
      !lockfile.includes("link:"),
    "packed client consumer lockfile escaped to the source workspace",
  );
}

async function verifyConsumerImports(archives, publicSpecifiers) {
  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot);
  const localPackages = Object.fromEntries(
    Object.entries(archives).map(([name, archive]) => [
      name,
      localArchiveSpecifier(consumerRoot, archive),
    ]),
  );
  const checkPath = join(consumerRoot, "check.mjs");
  await Promise.all([
    writeFile(
      join(consumerRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "moltzap-client-packed-consumer",
          version: "0.0.0",
          private: true,
          type: "module",
          dependencies: localPackages,
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(consumerRoot, "pnpm-workspace.yaml"),
      [
        "packages:",
        '  - "."',
        "overrides:",
        ...Object.entries(localPackages).map(
          ([name, specifier]) =>
            `  ${JSON.stringify(name)}: ${JSON.stringify(specifier)}`,
        ),
        "",
      ].join("\n"),
    ),
    writeFile(
      checkPath,
      publicSpecifiers
        .map((specifier) => `await import(${JSON.stringify(specifier)});`)
        .join("\n") +
        `\nconst server = await import("@moltzap/client/server");\n` +
        `if (Object.keys(server).join(",") !== "MoltZapDaemon") throw new Error("unexpected Client server exports");\n` +
        `if (Object.keys(server.MoltZapDaemon).sort().join(",") !== "StartupError,layer") throw new Error("unexpected MoltZapDaemon namespace");\n`,
    ),
  ]);
  await exec(
    "pnpm",
    ["install", "--no-frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
    { cwd: consumerRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  await verifyIsolatedInstall(consumerRoot);
  await exec(process.execPath, [checkPath], {
    cwd: consumerRoot,
    env: { ...process.env, NODE_PATH: undefined },
  });
}

try {
  const tarballs = join(temporaryRoot, "tarballs");
  await mkdir(tarballs);
  const archives = await packWorkspacePackages(workspacePackageRoots, tarballs);
  await readPackedManifests(archives, workspacePackageRoots);
  const extractedRoot = join(temporaryRoot, "extracted");
  await mkdir(extractedRoot);
  await exec("tar", ["-xzf", archives["@moltzap/client"], "-C", extractedRoot]);
  const extractedPackage = join(extractedRoot, "package");
  const publicSpecifiers = await verifyPackedManifest(extractedPackage);
  await verifyConsumerImports(archives, publicSpecifiers);
  process.stdout.write("client package consumer check passed\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
