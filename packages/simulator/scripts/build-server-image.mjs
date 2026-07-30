// Builds the simulator's per-run server image from the installed
// `@moltzap/server-core` and `@moltzap/protocol` packages and prints its pin:
// `{"image":…,"imageDigest":"sha256:…","serverCoreVersion":…}`.
//
// The tag fingerprints every image input, so matching package bytes reuse the
// local image and different bytes cannot resolve to an older build.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const imageDir = join(packageRoot, "server-image");

function packageRootOf(name) {
  let candidate = dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    const manifestPath = join(candidate, "package.json");
    if (existsSync(manifestPath) && readManifest(candidate).name === name) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error(`could not locate the installed ${name} package`);
    }
    candidate = parent;
  }
}

function dependencyPackageRoot(packageDir, name) {
  const segments = name.split("/");
  let candidateRoot = packageDir;
  for (;;) {
    const candidates = [
      join(candidateRoot, "node_modules", ...segments),
      ...(basename(candidateRoot) === "node_modules"
        ? [join(candidateRoot, ...segments)]
        : []),
    ];
    for (const candidate of candidates) {
      if (
        existsSync(join(candidate, "package.json")) &&
        readManifest(candidate).name === name
      ) {
        return realpathSync(candidate);
      }
    }
    const parent = dirname(candidateRoot);
    if (parent === candidateRoot) {
      throw new Error(
        `could not locate ${name} from the installed ${readManifest(packageDir).name} package`,
      );
    }
    candidateRoot = parent;
  }
}

const serverDir = packageRootOf("@moltzap/server-core");
const protocolDir = dependencyPackageRoot(serverDir, "@moltzap/protocol");
const workspaceCandidate = dirname(dirname(packageRoot));
const workspaceRoot =
  existsSync(join(workspaceCandidate, "pnpm-workspace.yaml")) &&
  serverDir === join(workspaceCandidate, "packages", "server")
    ? workspaceCandidate
    : undefined;

const IMAGE_REPOSITORY = "moltzap-sim-server";
const BUILD_TIMEOUT_MS = 900_000;
const INSPECT_TIMEOUT_MS = 30_000;
const PACK_TIMEOUT_MS = 300_000;

function report(stage) {
  process.stderr.write(`[moltzap simulator] ${stage}\n`);
}

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

function hashPath(hash, root, path, namespace) {
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
      hashPath(hash, root, join(path, entry), namespace);
    }
    return;
  }
  hash.update(`${namespace}/${relative(root, path).split(sep).join("/")}`);
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
    const namespace = readManifest(packageDir).name;
    for (const path of packedPaths(packageDir)) {
      hashPath(hash, packageDir, path, namespace);
    }
  }
  hashPath(
    hash,
    imageDir,
    join(imageDir, "Dockerfile"),
    "@moltzap/simulator/server-image",
  );
  hashPath(
    hash,
    imageDir,
    join(imageDir, "moltzap.yaml"),
    "@moltzap/simulator/server-image",
  );
  hashPath(
    hash,
    packageRoot,
    fileURLToPath(import.meta.url),
    "@moltzap/simulator",
  );
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
  if (workspaceRoot === undefined) {
    const { stdout } = await exec(
      "npm",
      ["pack", "--pack-destination", destination, "--json", "--ignore-scripts"],
      { cwd: packageDir, timeout: PACK_TIMEOUT_MS },
    );
    const packed = JSON.parse(stdout);
    const filename = Array.isArray(packed) ? packed[0]?.filename : undefined;
    if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
      throw new Error(`npm pack in ${packageDir} returned no tarball path`);
    }
    return basename(filename);
  }

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
  if (workspaceRoot !== undefined) {
    report("building the workspace server package");
    await exec("pnpm", ["nx", "build", "@moltzap/server-core"], {
      cwd: workspaceRoot,
      timeout: BUILD_TIMEOUT_MS,
    });
  }
  const version = readManifest(serverDir).version;
  const image = `${IMAGE_REPOSITORY}:${fingerprint()}`;
  report("checking the local production-router image cache");
  if (await imageExists(image)) {
    report(`reusing cached image ${image}`);
  } else {
    report("packing the protocol and server packages");
    const staging = await stage(version);
    try {
      report(`building Docker image ${image}`);
      await exec("docker", ["build", "--tag", image, staging], {
        timeout: BUILD_TIMEOUT_MS,
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  report("resolving the content-addressed image digest");
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

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) ===
    realpathSync(resolve(process.argv[1]))
) {
  await main();
}
