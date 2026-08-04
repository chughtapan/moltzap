import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const clientRoot = join(workspaceRoot, "packages", "client");
const protocolRoot = join(workspaceRoot, "packages", "protocol");
const temporaryRoot = await mkdtemp(join(tmpdir(), "moltzap-client-pack-"));

function requireCondition(condition, detail) {
  if (!condition) {
    throw new Error(detail);
  }
}

async function packedTarball(packageRoot) {
  const { stdout } = await exec(
    "pnpm",
    ["pack", "--pack-destination", temporaryRoot, "--json"],
    { cwd: packageRoot },
  );
  const packed = JSON.parse(stdout);
  const filename = Array.isArray(packed)
    ? packed[0]?.filename
    : packed.filename;
  requireCondition(
    typeof filename === "string",
    "pnpm pack returned no client tarball",
  );
  return resolve(packageRoot, filename);
}

async function verifyInstalledDaemon(clientTarball, protocolTarball) {
  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot);
  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      protocolTarball,
      clientTarball,
    ],
    { cwd: consumerRoot },
  );

  const nodeModules = join(consumerRoot, "node_modules");
  const clientManifest = JSON.parse(
    await readFile(
      join(nodeModules, "@moltzap", "client", "package.json"),
      "utf8",
    ),
  );
  const protocolManifest = JSON.parse(
    await readFile(
      join(nodeModules, "@moltzap", "protocol", "package.json"),
      "utf8",
    ),
  );
  requireCondition(
    clientManifest.dependencies?.["@moltzap/protocol"] ===
      protocolManifest.version,
    "packed client must own its exact @moltzap/protocol production dependency",
  );

  const daemon = join(nodeModules, ".bin", "moltzapd");
  const { stdout } = await exec(daemon, ["--help"], { cwd: consumerRoot });
  for (const expected of ["moltzapd", "USAGE", "--profile", "--port"]) {
    requireCondition(
      stdout.includes(expected),
      `packed moltzapd help is missing ${expected}`,
    );
  }
}

try {
  const [protocolTarball, clientTarball] = await Promise.all([
    packedTarball(protocolRoot),
    packedTarball(clientRoot),
  ]);
  await verifyInstalledDaemon(clientTarball, protocolTarball);
  process.stdout.write("client package daemon check passed\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
