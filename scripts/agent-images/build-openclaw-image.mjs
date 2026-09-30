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
/** Official native provider release matched to the pinned OpenClaw host. */
export const ZAI_PROVIDER_VERSION = "2026.8.1";
/** Stable image path a launcher includes in `plugins.load.paths`. */
export const ZAI_PROVIDER_PATH =
  "/opt/moltzap/node_modules/@openclaw/zai-provider";
/** Claude Code release installed into the image for the claude-cli agent runtime. */
export const CLAUDE_CODE_VERSION = "2.1.276";
/**
 * SHA-256 of that release's binary per Docker target architecture, copied
 * from the release's `manifest.json`. The Dockerfile refuses to run a download
 * that differs, so bump these together with the version.
 */
export const CLAUDE_CODE_SHA256 = Object.freeze({
  amd64: "8a56c8a14bd3cb246e2bdb7e60aefe0f609bff78c8bbcc5ea6b1817c111c6145",
  arm64: "e9ac3df956083645578a382ad64ec304468666e362c33bfdefd803cd6ff596b0",
});
const workspacePackages = {
  "@moltzap/client": join(workspaceRoot, "packages/client"),
  "@moltzap/identity": join(workspaceRoot, "packages/identity"),
  "@moltzap/openclaw-channel": join(workspaceRoot, "packages/openclaw-channel"),
  "@moltzap/router": join(workspaceRoot, "packages/router"),
};
export const openClawWorkspacePackageNames = Object.freeze(
  Object.keys(workspacePackages),
);

/**
 * Experiment controls for evaluations that compare agents with and without
 * collective operations. They are not for production images and may be
 * removed without notice. Each one appends its line to the staged Dockerfile,
 * which the fingerprint hashes, and its suffix to the tag, so a variant never
 * shares a tag with the default image or another variant. A build without
 * them stages the Dockerfile unchanged.
 *
 * `--experiment-hide-collectives` sets the plugin's
 * `MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES` for the host.
 * `--experiment-omit-collectives-skill` deletes the installed plugin's
 * `moltzap-collectives` skill directory, so OpenClaw does not list the skill.
 * @type {Readonly<Record<string, {tagSuffix: string, dockerfileLine: string}>>}
 */
export const OPENCLAW_EXPERIMENTS = Object.freeze({
  "--experiment-hide-collectives": {
    tagSuffix: "hide-collectives",
    dockerfileLine: "ENV MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES=true",
  },
  "--experiment-omit-collectives-skill": {
    tagSuffix: "omit-collectives-skill",
    dockerfileLine:
      "RUN rm -r /opt/moltzap/node_modules/@moltzap/openclaw-channel/skills/moltzap-collectives",
  },
});

/**
 * Separate the experiment flags from the shared image-build arguments.
 * @param {readonly string[]} args Process arguments after the script path.
 * @returns {{experiments: string[], buildArguments: string[]}} The experiment
 * flags in {@link OPENCLAW_EXPERIMENTS} order, and every other argument.
 */
export function splitExperimentArguments(args) {
  return {
    experiments: Object.keys(OPENCLAW_EXPERIMENTS).filter((flag) =>
      args.includes(flag),
    ),
    buildArguments: args.filter(
      (arg) => !Object.hasOwn(OPENCLAW_EXPERIMENTS, arg),
    ),
  };
}

/**
 * @param {string} dockerfile The source Dockerfile text.
 * @param {readonly string[]} experiments Selected experiment flags.
 * @returns {string} The Dockerfile to stage.
 */
export function experimentDockerfile(dockerfile, experiments) {
  if (experiments.length === 0) {
    return dockerfile;
  }
  return (
    dockerfile.replace(/\n?$/u, "\n") +
    experiments
      .map((flag) => OPENCLAW_EXPERIMENTS[flag].dockerfileLine + "\n")
      .join("")
  );
}

/**
 * @param {string} tag The fingerprint or the caller's tag.
 * @param {readonly string[]} experiments Selected experiment flags.
 * @returns {string} The tag with one suffix per experiment.
 */
export function experimentTag(tag, experiments) {
  const suffixed = [
    tag,
    ...experiments.map((flag) => OPENCLAW_EXPERIMENTS[flag].tagSuffix),
  ].join("-");
  if (suffixed.length > 128) {
    throw new TypeError(
      "OpenClaw image tag with experiment suffixes exceeds 128 characters",
    );
  }
  return suffixed;
}

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

/**
 * The staged install manifest also participates in the image fingerprint.
 * @param {Record<string, string>} archives Packed workspace packages by name.
 * @returns {{name: string, version: string, private: boolean, dependencies: Record<string, string>, overrides: Record<string, string>}} Image installation manifest.
 */
export function packageManifest(archives) {
  const workspaceDependencies = Object.fromEntries(
    Object.entries(archives).map(([name, archive]) => [
      name,
      "file:./tarballs/" + archive,
    ]),
  );
  return {
    name: "moltzap-openclaw-agent-image",
    version: "0.0.0-local",
    private: true,
    dependencies: {
      "@openclaw/zai-provider": ZAI_PROVIDER_VERSION,
      ...workspaceDependencies,
    },
    overrides: workspaceDependencies,
  };
}

/**
 * @param {string} root Staging directory.
 * @param {readonly string[]} experiments Selected experiment flags.
 * @returns {Promise<void>}
 */
async function stageDockerfile(root, experiments) {
  const dockerfile = await readFile(join(imageRoot, "Dockerfile"), "utf8");
  await writeFile(
    join(root, "Dockerfile"),
    experimentDockerfile(dockerfile, experiments),
  );
}

async function stage(experiments) {
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
    stageDockerfile(root, experiments),
    copyFile(
      join(imageRoot, "host-command.json"),
      join(root, "host-command.json"),
    ),
    copyFile(
      join(imageRoot, "claude-code-managed-settings.json"),
      join(root, "claude-code-managed-settings.json"),
    ),
    copyFile(
      join(imageRoot, "finalize-host.mjs"),
      join(root, "finalize-host.mjs"),
    ),
    copyFile(join(imageRoot, "host.sh"), join(root, "host.sh")),
    copyFile(
      join(imageRoot, "patch-openclaw.mjs"),
      join(root, "patch-openclaw.mjs"),
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

/**
 * Staged files whose content decides the image tag, beside the package
 * tarballs. A file the Dockerfile copies but this list omits changes the image
 * without changing its tag.
 * @type {readonly string[]}
 */
export const FINGERPRINTED_FILES = Object.freeze([
  "Dockerfile",
  "claude-code-managed-settings.json",
  "entrypoint.mjs",
  "finalize-host.mjs",
  "host-command.json",
  "host.sh",
  "package.json",
  "patch-openclaw.mjs",
  "register-daemon.mjs",
]);

/**
 * The default image tag: a hash of the base image, the Claude Code version,
 * every fingerprinted staged file, the package tarballs, and this script.
 * @param {string} root Staging directory.
 * @returns {Promise<string>} Sixteen hex characters.
 */
export async function fingerprint(root) {
  const hash = createHash("sha256");
  const paths = [
    ...FINGERPRINTED_FILES,
    ...(await readdir(join(root, "tarballs"))).map(
      (name) => "tarballs/" + name,
    ),
  ];
  hash.update(OPENCLAW_BASE_IMAGE);
  hash.update(CLAUDE_CODE_VERSION);
  for (const path of paths.sort()) {
    hash.update(path);
    hash.update(await readFile(join(root, path)));
  }
  hash.update(await readFile(fileURLToPath(import.meta.url)));
  return hash.digest("hex").slice(0, 16);
}

async function main() {
  const { experiments, buildArguments } = splitExperimentArguments(
    process.argv.slice(2),
  );
  const options = parseImageBuildArguments(buildArguments, {
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
    {
      cwd: workspaceRoot,
      timeout: BUILD_TIMEOUT_MILLIS,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const staging = await stage(experiments);
  try {
    const image =
      options.repository +
      ":" +
      experimentTag(options.tag ?? (await fingerprint(staging)), experiments);
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
        "--build-arg",
        "CLAUDE_CODE_VERSION=" + CLAUDE_CODE_VERSION,
        "--build-arg",
        "CLAUDE_CODE_SHA256_AMD64=" + CLAUDE_CODE_SHA256.amd64,
        "--build-arg",
        "CLAUDE_CODE_SHA256_ARM64=" + CLAUDE_CODE_SHA256.arm64,
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
        claudeCodeVersion: CLAUDE_CODE_VERSION,
        entrypoint: "/opt/moltzap/agent/entrypoint.mjs",
        experiments,
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
