// Builds the simulator's per-run server image from the workspace
// `@moltzap/server-core` bin and prints its pin as one JSON line:
// `{"image":…,"imageDigest":"sha256:…","serverCoreVersion":…}`.
// `imageDigest` is what a RunSpec's `server.imageDigest` carries.
//
// The image is content-addressed the way the NanoClaw install is: the tag
// carries a fingerprint over every input that reaches the image, so an
// unchanged workspace re-uses the built image and a changed one gets a new
// tag instead of silently reusing a stale layer.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(packageRoot));
const imageDir = join(packageRoot, "server-image");
const serverDir = join(workspaceRoot, "packages", "server");
const protocolDir = join(workspaceRoot, "packages", "protocol");

const IMAGE_REPOSITORY = "moltzap-sim-server";
const BUILD_TIMEOUT_MS = 900_000;
const INSPECT_TIMEOUT_MS = 30_000;
const PACK_TIMEOUT_MS = 300_000;

function readManifest(packageDir) {
  return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
}

/** Every published file of a package: what `pnpm pack` puts in the tarball. */
function packedPaths(packageDir) {
  const manifest = readManifest(packageDir);
  return ["package.json", ...(manifest.files ?? [])].map((entry) =>
    join(packageDir, entry),
  );
}

function hashPath(hash, root, path) {
  // A published entry that is not on disk (a glob, a moved build output)
  // would silently shrink the fingerprint and let a stale image answer for
  // a changed workspace.
  if (!existsSync(path)) {
    throw new Error(
      `published path ${path} does not exist; the image fingerprint would not cover it`,
    );
  }
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      hashPath(hash, root, join(path, entry));
    }
    return;
  }
  hash.update(relative(root, path).split(sep).join("/"));
  hash.update(readFileSync(path));
}

/**
 * Fingerprint over the exact bytes that reach the image: both packages'
 * published files plus this directory's Dockerfile and config. Tarball
 * bytes are deliberately not used — archive metadata makes them unstable
 * across otherwise identical packs.
 */
function fingerprint() {
  const hash = createHash("sha256");
  for (const packageDir of [protocolDir, serverDir]) {
    for (const path of packedPaths(packageDir)) {
      hashPath(hash, workspaceRoot, path);
    }
  }
  hashPath(hash, imageDir, join(imageDir, "Dockerfile"));
  hashPath(hash, imageDir, join(imageDir, "moltzap.yaml"));
  return hash.digest("hex").slice(0, 16);
}

async function imageExists(image) {
  try {
    await exec("docker", ["image", "inspect", image], {
      timeout: INSPECT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

async function packInto(packageDir, destination) {
  const { stdout } = await exec(
    "pnpm",
    ["pack", "--pack-destination", destination],
    { cwd: packageDir, timeout: PACK_TIMEOUT_MS },
  );
  const printed = stdout.trim().split("\n").at(-1);
  if (printed === undefined || !printed.endsWith(".tgz")) {
    throw new Error(`pnpm pack in ${packageDir} printed no tarball path`);
  }
  return basename(printed);
}

async function stage(version) {
  const staging = await mkdtemp(join(tmpdir(), "moltzap-server-image-"));
  const tarballs = join(staging, "tarballs");
  await mkdir(tarballs);
  // Independent packs of independent packages; each is a full pnpm startup.
  const [protocolTarball, serverTarball] = await Promise.all([
    packInto(protocolDir, tarballs),
    packInto(serverDir, tarballs),
  ]);
  // `overrides` forces the workspace protocol tarball in place of the
  // registry version server-core's manifest names, so the image carries
  // the tree under test rather than the last published release.
  const manifest = {
    name: "moltzap-sim-server-image",
    version,
    private: true,
    dependencies: {
      "@moltzap/server-core": `file:./tarballs/${serverTarball}`,
    },
    overrides: {
      "@moltzap/protocol": `file:./tarballs/${protocolTarball}`,
    },
  };
  await Promise.all([
    writeFile(
      join(staging, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
    copyFile(join(imageDir, "Dockerfile"), join(staging, "Dockerfile")),
    copyFile(join(imageDir, "moltzap.yaml"), join(staging, "moltzap.yaml")),
  ]);
  return staging;
}

async function main() {
  await exec("pnpm", ["nx", "build", "@moltzap/server-core"], {
    cwd: workspaceRoot,
    timeout: BUILD_TIMEOUT_MS,
  });
  const version = readManifest(serverDir).version;
  const image = `${IMAGE_REPOSITORY}:${fingerprint()}`;
  if (!(await imageExists(image))) {
    const staging = await stage(version);
    try {
      await exec("docker", ["build", "--tag", image, staging], {
        timeout: BUILD_TIMEOUT_MS,
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const { stdout } = await exec(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", image],
    { timeout: INSPECT_TIMEOUT_MS },
  );
  const imageDigest = stdout.trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    throw new Error(`docker reported an unusable image id: ${imageDigest}`);
  }
  process.stdout.write(
    `${JSON.stringify({ image, imageDigest, serverCoreVersion: version })}\n`,
  );
}

await main();
