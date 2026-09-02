import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
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
const packageRoots = Object.freeze({
  "@moltzap/client": join(workspaceRoot, "packages", "client"),
  "@moltzap/identity": join(workspaceRoot, "packages", "identity"),
  "@moltzap/nanoclaw-channel": join(
    workspaceRoot,
    "packages",
    "nanoclaw-channel",
  ),
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
});
const ROOT_EXPORT = Object.freeze({
  types: "./dist/channels/moltzap.d.ts",
  import: "./dist/channels/moltzap.js",
});
const temporaryRoot = await mkdtemp(join(tmpdir(), "moltzap-nanoclaw-pack-"));

function requireCondition(condition, detail) {
  if (!condition) {
    throw new Error(detail);
  }
}

async function verifyPackedManifest(archive, manifests) {
  const extractedRoot = join(temporaryRoot, "extracted");
  await mkdir(extractedRoot);
  await exec("tar", ["-xzf", archive, "-C", extractedRoot]);
  const extractedPackage = join(extractedRoot, "package");
  const manifest = manifests["@moltzap/nanoclaw-channel"];
  requireCondition(
    manifest.name === "@moltzap/nanoclaw-channel",
    "packed NanoClaw manifest has the wrong package name",
  );
  requireCondition(
    manifest.main === ROOT_EXPORT.import &&
      manifest.types === ROOT_EXPORT.types,
    "packed NanoClaw main and types must match its root export",
  );
  requireCondition(
    JSON.stringify(manifest.exports) === JSON.stringify({ ".": ROOT_EXPORT }),
    "packed NanoClaw package must expose exactly its root entrypoint",
  );
  requireCondition(
    manifest.dependencies?.["@moltzap/client"] ===
      manifests["@moltzap/client"].version,
    "packed NanoClaw package must use the packed Client version",
  );
  await Promise.all(
    [ROOT_EXPORT.import, ROOT_EXPORT.types].map((path) =>
      readFile(join(extractedPackage, path)).catch((cause) => {
        throw new Error(`packed NanoClaw package is missing ${path}`, {
          cause,
        });
      }),
    ),
  );
}

function archiveSpecifier(consumerRoot, archive) {
  return `file:${relative(consumerRoot, archive)}`;
}

async function verifyIsolatedInstall(consumerRoot) {
  const installedRoot = await realpath(consumerRoot);
  const lockfile = await readFile(join(consumerRoot, "pnpm-lock.yaml"), "utf8");
  requireCondition(
    !lockfile.includes(workspaceRoot) &&
      !lockfile.includes("workspace:") &&
      !lockfile.includes("link:"),
    "packed consumer lockfile escaped to a workspace or linked dependency",
  );
  for (const packageName of Object.keys(packageRoots)) {
    const installed = await realpath(
      join(consumerRoot, "node_modules", ...packageName.split("/")),
    );
    requireCondition(
      installed.startsWith(`${installedRoot}/`),
      `packed consumer resolved ${packageName} outside its isolated install`,
    );
  }
}

async function verifyConsumer(archives) {
  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot);
  const localPackages = Object.fromEntries(
    Object.entries(archives).map(([name, archive]) => [
      name,
      archiveSpecifier(consumerRoot, archive),
    ]),
  );
  const checkPath = join(consumerRoot, "check.mjs");
  await Promise.all([
    writeFile(
      join(consumerRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "moltzap-nanoclaw-packed-consumer",
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
        'packages: ["."]',
        "overrides:",
        ...Object.entries(localPackages).map(
          ([name, archive]) =>
            `  ${JSON.stringify(name)}: ${JSON.stringify(archive)}`,
        ),
        "",
      ].join("\n"),
    ),
    writeFile(
      checkPath,
      [
        'const adapter = await import("@moltzap/nanoclaw-channel");',
        'if (Object.keys(adapter).sort().join(",") !== "MoltZapAdapter,makeMoltZapAdapter") {',
        '  throw new Error(`unexpected NanoClaw adapter exports: ${Object.keys(adapter).join(",")}`);',
        "}",
        "",
      ].join("\n"),
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
  const archives = await packWorkspacePackages(packageRoots, tarballs);
  const manifests = await readPackedManifests(archives, packageRoots);
  await verifyPackedManifest(archives["@moltzap/nanoclaw-channel"], manifests);
  await verifyConsumer(archives);
  process.stdout.write("NanoClaw packed consumer check passed\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
