// Builds the NanoClaw application image and prints both its local tag and
// manifest-digest identity. The caller decides whether to load or push it.
//
// `@moltzap/evals` requires MOLTZAP_NANOCLAW_IMAGE as a digest-pinned
// reference, and the digest a registry assigns is only knowable after a push,
// so this prints `pinnedImage` for the local repository and leaves publication
// to the caller — the same split the controller image uses.
//
// NanoClaw runs every agent turn in a container it spawns itself, so a cell
// running this image also needs a reachable container runtime (DOCKER_HOST).
// The image carries the client; it cannot carry the daemon.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(packageRoot));
const imageRoot = join(packageRoot, "nanoclaw-image");
const assetsRoot = join(packageRoot, "nanoclaw-assets");
const channelSource = join(
  workspaceRoot,
  "packages",
  "nanoclaw-channel",
  "src",
  "channels",
  "moltzap.ts",
);

/**
 * Pinned NanoClaw source revision. The image's runtime version is this commit,
 * not the version string in the overlaid manifest.
 */
export const NANOCLAW_SOURCE_REVISION =
  "641963c1e4b7ba4f000a18dfc5e2fea29069feec";
const NANOCLAW_SOURCE_URL = `https://github.com/nanocoai/nanoclaw/archive/${NANOCLAW_SOURCE_REVISION}.tar.gz`;
const DEFAULT_REPOSITORY = "moltzap-simulator-nanoclaw";
const BUILD_TIMEOUT_MS = 45 * 60 * 1_000;
const PACK_TIMEOUT_MS = 5 * 60 * 1_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const BUNDLED_ASSETS = [
  "SKILL.md",
  "moltzap-eval-provision.ts",
  "package.json",
  "package-lock.json",
];
// The channel the image builds is the workspace one, so its two MoltZap
// dependencies are the workspace ones too; a published copy beside them is the
// drift the packed tarballs exist to prevent.
const workspacePackages = {
  "@moltzap/client": join(workspaceRoot, "packages", "client"),
  "@moltzap/protocol": join(workspaceRoot, "packages", "protocol"),
};

/**
 * Refuse a repository that could not name one immutable image.
 * @param repository Repository the image will be tagged into.
 */
export function assertRepository(repository) {
  // The repository half excludes `@` so a trailing digest cannot be smuggled in
  // behind an earlier one — the same reason the image schema excludes it. One
  // rule, checked when the argument arrives rather than only after the build.
  if (repository.length === 0 || /[@\s]/.test(repository)) {
    throw new TypeError(
      "a nanoclaw image repository must be nonempty and carry no digest",
    );
  }
}

/**
 * Digest-pinned reference accepted by the evaluation image schema.
 * @param repository Local or remote repository the image was tagged into.
 * @param digest Manifest digest reported by the build.
 * @returns The immutable `repository@sha256:<64 hex>` reference.
 */
export function pinnedImageReference(repository, digest) {
  assertRepository(repository);
  if (!SHA256_DIGEST.test(digest)) {
    throw new TypeError("a pinned image needs a lowercase SHA-256 digest");
  }
  return `${repository}@${digest}`;
}

function report(message) {
  process.stderr.write(`[moltzap nanoclaw image] ${message}\n`);
}

function parseArguments(args) {
  if (args.length === 0) {
    return { repository: DEFAULT_REPOSITORY };
  }
  if (args.length !== 2 || args[0] !== "--repository") {
    throw new TypeError("usage: build-nanoclaw-image.mjs [--repository NAME]");
  }
  const repository = args[1];
  assertRepository(repository);
  return { repository };
}

async function pack(packageDirectory, destination) {
  const { stdout } = await exec(
    "pnpm",
    ["pack", "--pack-destination", destination],
    { cwd: packageDirectory, timeout: PACK_TIMEOUT_MS },
  );
  const path = stdout.trim().split("\n").at(-1);
  if (path === undefined || !path.endsWith(".tgz")) {
    throw new Error(`pnpm pack returned no archive for ${packageDirectory}`);
  }
  return basename(path);
}

async function downloadSource() {
  const response = await fetch(NANOCLAW_SOURCE_URL, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `NanoClaw source ${NANOCLAW_SOURCE_REVISION} returned HTTP ${String(response.status)}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function stage(source) {
  const root = await mkdtemp(join(tmpdir(), "moltzap-nanoclaw-image-"));
  const tarballs = join(root, "tarballs");
  const assets = join(root, "assets");
  await Promise.all([mkdir(tarballs), mkdir(assets)]);
  await Promise.all([
    writeFile(join(root, "nanoclaw-source.tar.gz"), await source),
    copyFile(join(imageRoot, "Dockerfile"), join(root, "Dockerfile")),
    copyFile(join(imageRoot, "prepare.mjs"), join(root, "prepare.mjs")),
    copyFile(join(imageRoot, "entrypoint.mjs"), join(root, "entrypoint.mjs")),
    copyFile(channelSource, join(assets, "moltzap.ts")),
    ...BUNDLED_ASSETS.map((name) =>
      copyFile(join(assetsRoot, name), join(assets, name)),
    ),
    ...Object.values(workspacePackages).map((directory) =>
      pack(directory, tarballs),
    ),
  ]);
  return root;
}

async function stagedFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath.slice(root.length + 1), entry.name));
}

async function fingerprint(root) {
  const hash = createHash("sha256");
  hash.update(NANOCLAW_SOURCE_REVISION);
  for (const path of (await stagedFiles(root)).sort()) {
    hash.update(path);
    hash.update(await readFile(join(root, path)));
  }
  hash.update(await readFile(fileURLToPath(import.meta.url)));
  return hash.digest("hex").slice(0, 16);
}

function buildDigest(metadata) {
  const digest = metadata["containerimage.digest"];
  if (typeof digest !== "string" || !SHA256_DIGEST.test(digest)) {
    throw new Error("docker buildx returned no manifest digest");
  }
  return digest;
}

async function buildImage(staging, image) {
  const metadataPath = join(staging, "build-metadata.json");
  report(`building ${image}`);
  await exec(
    "docker",
    [
      "buildx",
      "build",
      "--load",
      "--metadata-file",
      metadataPath,
      "--tag",
      image,
      staging,
    ],
    { timeout: BUILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  );
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const { stdout } = await exec(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", image],
    { timeout: 30_000 },
  );
  const imageId = stdout.trim();
  if (!SHA256_DIGEST.test(imageId)) {
    throw new Error("docker returned no local nanoclaw image id");
  }
  return { imageDigest: buildDigest(metadata), imageId };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  // Started first and awaited in `stage`: the pinned source depends on nothing
  // the workspace build produces, so its transfer hides behind that build.
  const source = downloadSource();
  report("building the workspace dependencies the MoltZap channel consumes");
  await exec(
    "pnpm",
    [
      "nx",
      "run-many",
      "--target=build",
      "--projects=@moltzap/client,@moltzap/protocol",
    ],
    { cwd: workspaceRoot, timeout: BUILD_TIMEOUT_MS },
  );
  report(`staging NanoClaw ${NANOCLAW_SOURCE_REVISION} and its overlay`);
  const staging = await stage(source);
  try {
    const image = `${options.repository}:${await fingerprint(staging)}`;
    const { imageDigest, imageId } = await buildImage(staging, image);
    process.stdout.write(
      `${JSON.stringify({
        image,
        pinnedImage: pinnedImageReference(options.repository, imageDigest),
        imageDigest,
        imageId,
        sourceRevision: NANOCLAW_SOURCE_REVISION,
        applicationEntrypoint: "/opt/moltzap/nanoclaw/entrypoint.mjs",
        bootstrapConfig: "/var/run/moltzap/bootstrap/nanoclaw/runtime.json",
        stateDirectory: "/var/lib/moltzap/nanoclaw",
        gatewayPort: 18790,
      })}\n`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
