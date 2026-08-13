import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
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

const retiredOutputPattern =
  /^dist\/(?:cli\/|local-daemon-rpc\.|local-history\.|local-socket-server\.|service-local-daemon\.|service-socket-path\.)/;
const retiredDependencies = [
  "@effect/cli",
  "@effect/printer",
  "@effect/printer-ansi",
  "@effect/typeclass",
];

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

async function collectPackedFiles(root, relativeDirectory = "") {
  const files = [];
  for (const entry of await readdir(join(root, relativeDirectory), {
    withFileTypes: true,
  })) {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectPackedFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
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
    manifest.bin?.moltzap === undefined,
    "packed client still exposes the retired moltzap executable",
  );
  for (const dependency of retiredDependencies) {
    requireCondition(
      manifest.dependencies?.[dependency] === undefined &&
        manifest.devDependencies?.[dependency] === undefined,
      `packed client still depends on retired package ${dependency}`,
    );
  }
  requireCondition(
    manifest.devDependencies?.tsx === undefined,
    "packed client still carries the retired CLI generator runtime",
  );
  requireCondition(
    manifest.scripts?.["test:integration"] === undefined,
    "packed client still exposes the retired server-backed integration target",
  );

  const exportEntries = Object.entries(manifest.exports ?? {});
  requireCondition(
    exportEntries.length > 0,
    "packed client exposes no entrypoints",
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
      .join("\n") + "\n",
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
  const retiredOutputs = (await collectPackedFiles(extractedPackage)).filter(
    (path) => retiredOutputPattern.test(path),
  );
  requireCondition(
    retiredOutputs.length === 0,
    `packed client contains retired outputs: ${retiredOutputs.join(", ")}`,
  );
  await verifyConsumerImports(extractedPackage, publicSpecifiers);
  process.stdout.write("client package cutover check passed\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
