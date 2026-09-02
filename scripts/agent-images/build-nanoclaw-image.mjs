/** @file Builds the pinned, complete NanoClaw agent image. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = dirname(dirname(scriptRoot));
const imageRoot = join(scriptRoot, "nanoclaw");
const sharedRoot = join(scriptRoot, "shared");
const DEFAULT_REPOSITORY = "moltzap-nanoclaw-agent";
const BUILD_RESULT_PATH = join(
  workspaceRoot,
  ".moltzap/agent-images/nanoclaw.json",
);
const NANOCLAW_PATCH_PATH =
  "scripts/agent-images/nanoclaw/nanoclaw-v2.3.0.patch";
const BUILD_TIMEOUT_MILLIS = 45 * 60 * 1_000;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export const NANOCLAW_SOURCE_REVISION =
  "54d9d9a50c0e572fa3969d63ab87a4dd3d75cc6f";
export const NANOCLAW_SOURCE_ARCHIVE_SHA256 =
  "68663a0a06feb64d2366b7d6770a2ad9afc82765c9f1e8f0245bd4cbabeb1006";
export const NANOCLAW_SOURCE_URL = `https://github.com/nanocoai/nanoclaw/archive/${NANOCLAW_SOURCE_REVISION}.tar.gz`;
export const nanoclawWorkspacePackageNames = Object.freeze([
  "@moltzap/client",
  "@moltzap/identity",
  "@moltzap/router",
  "@moltzap/nanoclaw-channel",
]);

const packageDirectories = {
  client: join(workspaceRoot, "packages/client"),
  identity: join(workspaceRoot, "packages/identity"),
  router: join(workspaceRoot, "packages/router"),
};

function report(message) {
  process.stderr.write(`[moltzap nanoclaw image] ${message}\n`);
}

function parseArguments(args) {
  if (args.length === 0) return { repository: DEFAULT_REPOSITORY };
  if (args.length !== 2 || args[0] !== "--repository") {
    throw new TypeError("usage: build-nanoclaw-image.mjs [--repository NAME]");
  }
  if (args[1].length === 0 || args[1].includes("@")) {
    throw new TypeError(
      "NanoClaw image repository must not be empty or contain a digest",
    );
  }
  return { repository: args[1] };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function downloadSource(destination) {
  const response = await fetch(NANOCLAW_SOURCE_URL, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `NanoClaw source download failed: ${String(response.status)} ${response.statusText}`,
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = sha256(archive);
  if (digest !== NANOCLAW_SOURCE_ARCHIVE_SHA256) {
    throw new Error(
      `NanoClaw source archive digest mismatch: expected ${NANOCLAW_SOURCE_ARCHIVE_SHA256}, got ${digest}`,
    );
  }
  await writeFile(destination, archive);
}

async function pack(name, packageDirectory, destination) {
  const { stdout } = await exec(
    "pnpm",
    ["pack", "--pack-destination", destination],
    {
      cwd: packageDirectory,
      timeout: 5 * 60 * 1_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const generated = stdout.trim().split("\n").at(-1);
  if (generated === undefined || !generated.endsWith(".tgz")) {
    throw new Error(`pnpm pack returned no archive for ${packageDirectory}`);
  }
  const stablePath = join(destination, `${name}.tgz`);
  await copyFile(resolve(packageDirectory, generated), stablePath);
  if (resolve(packageDirectory, generated) !== stablePath) {
    await rm(resolve(packageDirectory, generated), { force: true });
  }
  return stablePath;
}

async function copyImageAssets(staging) {
  const assets = [
    "Dockerfile",
    "preload.mjs",
    "prepare.mjs",
    "process-driver.mjs",
    "provision.mjs",
  ];
  await Promise.all(
    assets.map((name) => copyFile(join(imageRoot, name), join(staging, name))),
  );
  await copyFile(
    join(workspaceRoot, NANOCLAW_PATCH_PATH),
    join(staging, "nanoclaw-v2.3.0.patch"),
  );
  await mkdir(join(staging, "channel"));
  await copyFile(
    join(workspaceRoot, "packages/nanoclaw-channel/src/channels/moltzap.ts"),
    join(staging, "channel/moltzap.ts"),
  );
  await Promise.all([
    copyFile(
      join(imageRoot, "entrypoint.mjs"),
      join(staging, "nanoclaw-entrypoint.mjs"),
    ),
    copyFile(
      join(imageRoot, "host-command.json"),
      join(staging, "host-command.json"),
    ),
    copyFile(
      join(sharedRoot, "entrypoint.mjs"),
      join(staging, "entrypoint.mjs"),
    ),
    copyFile(
      join(sharedRoot, "register-daemon.mjs"),
      join(staging, "register-daemon.mjs"),
    ),
  ]);
}

async function stage() {
  const staging = await mkdtemp(join(tmpdir(), "moltzap-nanoclaw-image-"));
  const sourceArchive = join(staging, "nanoclaw.tar.gz");
  const source = join(staging, "source");
  const tarballs = join(staging, "tarballs");
  await Promise.all([mkdir(source), mkdir(tarballs)]);
  report(`downloading NanoClaw ${NANOCLAW_SOURCE_REVISION}`);
  await downloadSource(sourceArchive);
  await exec(
    "tar",
    ["-xzf", sourceArchive, "--strip-components=1", "-C", source],
    { timeout: 2 * 60 * 1_000 },
  );
  await rm(sourceArchive);
  await copyImageAssets(staging);
  await Promise.all(
    Object.entries(packageDirectories).map(([name, directory]) =>
      pack(name, directory, tarballs),
    ),
  );
  return staging;
}

async function stagingFingerprint(staging) {
  const hash = createHash("sha256");
  hash.update(NANOCLAW_SOURCE_ARCHIVE_SHA256);
  for (const path of [
    "Dockerfile",
    "channel/moltzap.ts",
    "entrypoint.mjs",
    "host-command.json",
    "nanoclaw-v2.3.0.patch",
    "nanoclaw-entrypoint.mjs",
    "preload.mjs",
    "prepare.mjs",
    "process-driver.mjs",
    "provision.mjs",
    "register-daemon.mjs",
    "tarballs/client.tgz",
    "tarballs/identity.tgz",
    "tarballs/router.tgz",
  ]) {
    hash.update(path);
    hash.update(await readFile(join(staging, path)));
  }
  hash.update(await readFile(fileURLToPath(import.meta.url)));
  return hash.digest("hex").slice(0, 16);
}

function metadataDigest(metadata) {
  const digest = metadata["containerimage.digest"];
  if (typeof digest !== "string" || !SHA256_DIGEST.test(digest)) {
    throw new Error("docker buildx returned no manifest digest");
  }
  return digest;
}

async function inspectImage(image) {
  const { stdout } = await exec(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", image],
    { timeout: 30_000 },
  );
  const imageId = stdout.trim();
  if (!SHA256_DIGEST.test(imageId)) {
    throw new Error(`docker returned no image ID for ${image}`);
  }
  return imageId;
}

async function imageLabels(image) {
  const { stdout } = await exec(
    "docker",
    ["image", "inspect", "--format", "{{json .Config.Labels}}", image],
    { timeout: 30_000 },
  );
  const labels = JSON.parse(stdout);
  if (labels === null || typeof labels !== "object") {
    throw new Error(`docker returned no labels for ${image}`);
  }
  return labels;
}

async function buildAgentBase(staging) {
  const image = `moltzap-nanoclaw-agent-base:${NANOCLAW_SOURCE_REVISION.slice(0, 16)}`;
  const lockDigest = sha256(
    await readFile(join(staging, "source/container/agent-runner/bun.lock")),
  );
  try {
    await inspectImage(image);
    const labels = await imageLabels(image);
    if (
      labels["dev.nanoclaw.image-source"] ===
        `nanoclaw@${NANOCLAW_SOURCE_REVISION}` &&
      labels["dev.nanoclaw.agent-runner-lock-sha256"] === lockDigest
    ) {
      report(`reusing stock NanoClaw agent base ${image}`);
      return image;
    }
    report(`rebuilding mismatched NanoClaw agent base ${image}`);
  } catch {
    // Build below when the exact pinned base is not present locally.
  }
  report(`building stock NanoClaw agent base ${image}`);
  await exec(
    "docker",
    [
      "buildx",
      "build",
      "--load",
      "--tag",
      image,
      "--build-arg",
      `AGENT_RUNNER_LOCK_SHA256=${lockDigest}`,
      "--build-arg",
      `IMAGE_SOURCE=nanoclaw@${NANOCLAW_SOURCE_REVISION}`,
      "--file",
      join(staging, "source/container/Dockerfile"),
      join(staging, "source/container"),
    ],
    { timeout: BUILD_TIMEOUT_MILLIS, maxBuffer: 32 * 1024 * 1024 },
  );
  return image;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  report("building MoltZap workspace dependencies");
  await exec(
    "pnpm",
    [
      "nx",
      "run-many",
      "--target=build",
      `--projects=${nanoclawWorkspacePackageNames.join(",")}`,
    ],
    {
      cwd: workspaceRoot,
      timeout: BUILD_TIMEOUT_MILLIS,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const staging = await stage();
  try {
    const fingerprint = await stagingFingerprint(staging);
    const agentBaseImage = await buildAgentBase(staging);
    const image = `${options.repository}:${fingerprint}`;
    const metadataPath = join(staging, "build-metadata.json");
    report(`building application image ${image}`);
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
        "--build-arg",
        `NANOCLAW_AGENT_IMAGE=${agentBaseImage}`,
        "--build-arg",
        `NANOCLAW_SOURCE_REVISION=${NANOCLAW_SOURCE_REVISION}`,
        "--build-arg",
        `NANOCLAW_SOURCE_ARCHIVE_SHA256=${NANOCLAW_SOURCE_ARCHIVE_SHA256}`,
        staging,
      ],
      { timeout: BUILD_TIMEOUT_MILLIS, maxBuffer: 32 * 1024 * 1024 },
    );
    const imageDigest = metadataDigest(
      JSON.parse(await readFile(metadataPath, "utf8")),
    );
    const imageId = await inspectImage(image);
    const result = {
      image,
      pinnedImage: `${options.repository}@${imageDigest}`,
      imageDigest,
      imageId,
      sourceRevision: NANOCLAW_SOURCE_REVISION,
      sourceArchiveDigest: `sha256:${NANOCLAW_SOURCE_ARCHIVE_SHA256}`,
      agentBaseImage,
      entrypoint: "/opt/moltzap/agent/entrypoint.mjs",
      stateDirectory: "/var/lib/moltzap/nanoclaw",
      gatewayPort: 18_790,
    };
    await mkdir(dirname(BUILD_RESULT_PATH), { recursive: true });
    await writeFile(BUILD_RESULT_PATH, `${JSON.stringify(result)}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
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
