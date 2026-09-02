/** Build a complete OpenClaw agent image from pinned upstream and local packages. */

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
import {
  localImageId,
  metadataDigest,
  parseImageBuildArguments,
} from "../images/build.mjs";

const exec = promisify(execFile);
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = dirname(dirname(scriptRoot));
const imageRoot = join(scriptRoot, "openclaw");
const sharedRoot = join(scriptRoot, "shared");
const DEFAULT_REPOSITORY = "moltzap-openclaw-agent";
const BUILD_TIMEOUT_MILLIS = 30 * 60 * 1_000;
const PACK_TIMEOUT_MILLIS = 5 * 60 * 1_000;

export const OPENCLAW_BASE_IMAGE =
  "ghcr.io/openclaw/openclaw@sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4";
const workspacePackages = {
  "@moltzap/client": join(workspaceRoot, "packages/client"),
  "@moltzap/identity": join(workspaceRoot, "packages/identity"),
  "@moltzap/openclaw-channel": join(workspaceRoot, "packages/openclaw-channel"),
  "@moltzap/router": join(workspaceRoot, "packages/router"),
};
export const openClawWorkspacePackageNames = Object.freeze(
  Object.keys(workspacePackages),
);

function report(message) {
  process.stderr.write("[moltzap openclaw image] " + message + "\n");
}

async function pack(packageDirectory, destination) {
  const { stdout } = await exec(
    "pnpm",
    ["pack", "--pack-destination", destination],
    { cwd: packageDirectory, timeout: PACK_TIMEOUT_MILLIS },
  );
  const path = stdout.trim().split("\n").at(-1);
  if (path === undefined || !path.endsWith(".tgz")) {
    throw new Error("pnpm pack returned no archive for " + packageDirectory);
  }
  return basename(path);
}

function packageManifest(archives) {
  const dependencies = Object.fromEntries(
    Object.entries(archives).map(([name, archive]) => [
      name,
      "file:./tarballs/" + archive,
    ]),
  );
  return {
    name: "moltzap-openclaw-agent-image",
    version: "0.0.0-local",
    private: true,
    dependencies,
    overrides: dependencies,
  };
}

async function stage() {
  const root = await mkdtemp(join(tmpdir(), "moltzap-openclaw-image-"));
  const tarballs = join(root, "tarballs");
  await mkdir(tarballs);
  const packed = await Promise.all(
    Object.entries(workspacePackages).map(async ([name, directory]) => [
      name,
      await pack(directory, tarballs),
    ]),
  );
  const archives = Object.fromEntries(packed);
  await Promise.all([
    copyFile(join(imageRoot, "Dockerfile"), join(root, "Dockerfile")),
    copyFile(
      join(imageRoot, "host-command.json"),
      join(root, "host-command.json"),
    ),
    copyFile(join(sharedRoot, "entrypoint.mjs"), join(root, "entrypoint.mjs")),
    copyFile(
      join(sharedRoot, "register-daemon.mjs"),
      join(root, "register-daemon.mjs"),
    ),
    writeFile(
      join(root, "package.json"),
      JSON.stringify(packageManifest(archives), null, 2) + "\n",
    ),
  ]);
  return root;
}

async function fingerprint(root) {
  const hash = createHash("sha256");
  const paths = [
    "Dockerfile",
    "entrypoint.mjs",
    "host-command.json",
    "package.json",
    "register-daemon.mjs",
    ...(await readdir(join(root, "tarballs"))).map(
      (name) => "tarballs/" + name,
    ),
  ];
  hash.update(OPENCLAW_BASE_IMAGE);
  for (const path of paths.sort()) {
    hash.update(path);
    hash.update(await readFile(join(root, path)));
  }
  hash.update(await readFile(fileURLToPath(import.meta.url)));
  return hash.digest("hex").slice(0, 16);
}

async function main() {
  const options = parseImageBuildArguments(process.argv.slice(2), {
    script: "build-openclaw-image.mjs",
    label: "OpenClaw image",
    defaultRepository: DEFAULT_REPOSITORY,
  });
  report("building MoltZap workspace dependencies");
  await exec(
    "pnpm",
    [
      "nx",
      "run-many",
      "--target=build",
      "--projects=" + openClawWorkspacePackageNames.join(","),
    ],
    { cwd: workspaceRoot, timeout: BUILD_TIMEOUT_MILLIS },
  );
  const staging = await stage();
  try {
    const image =
      options.repository + ":" + (options.tag ?? (await fingerprint(staging)));
    const metadataPath = join(staging, "build-metadata.json");
    report((options.push ? "building and pushing " : "building ") + image);
    await exec(
      "docker",
      [
        "buildx",
        "build",
        options.push ? "--push" : "--load",
        "--metadata-file",
        metadataPath,
        "--tag",
        image,
        "--build-arg",
        "OPENCLAW_BASE_IMAGE=" + OPENCLAW_BASE_IMAGE,
        staging,
      ],
      { timeout: BUILD_TIMEOUT_MILLIS, maxBuffer: 32 * 1024 * 1024 },
    );
    const imageDigest = metadataDigest(
      JSON.parse(await readFile(metadataPath, "utf8")),
    );
    process.stdout.write(
      JSON.stringify({
        image,
        pinnedImage: options.repository + "@" + imageDigest,
        imageDigest,
        ...(options.push
          ? {}
          : { imageId: await localImageId(image, "OpenClaw image") }),
        baseImage: OPENCLAW_BASE_IMAGE,
        entrypoint: "/opt/moltzap/agent/entrypoint.mjs",
        gatewayPort: 18_789,
      }) + "\n",
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
