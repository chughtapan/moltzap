/**
 * @file Builds a complete OpenClaw agent image from pinned upstream and local
 * packages.
 *
 * It packs the workspace packages' `dist/` as they stand and builds none of
 * them: run it through `nx run workspace:openclaw-agent-image`, whose
 * `dependsOn` has the invoking Nx graph build them first. A build started from
 * here would be a second Nx process writing the same `dist/` while that graph's
 * own builds run; one process's `clean-dist` then removes the other's emitted
 * files, and the partial tree is cached under the build's hash.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
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

/**
 * Experiment controls for evaluations that compare agents with and without
 * gather, all_gather and answers. They are not for production images and may be
 * removed without notice. Each one appends its line to the staged Dockerfile,
 * which the fingerprint hashes, and its suffix to the tag, so a variant never
 * shares a tag with the default image or another variant. A build without
 * them stages the Dockerfile unchanged.
 *
 * `--experiment-hide-collectives` sets the plugin's
 * `MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES` for the host.
 * `--experiment-omit-collectives-skill` deletes the installed plugin's
 * `group-messaging` skill directory, so OpenClaw does not list the skill.
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
      "RUN rm -r /opt/moltzap/node_modules/@moltzap/openclaw-channel/skills/group-messaging",
  },
});

/** The installed plugin's group-messaging skill directory. */
const GROUP_MESSAGING_SKILL_PATH =
  "/opt/moltzap/node_modules/@moltzap/openclaw-channel/skills/group-messaging";

/**
 * Experiment control that replaces the model-facing group-messaging skill
 * with a candidate's, for a loop that compares candidates without a release
 * per attempt. Like {@link OPENCLAW_EXPERIMENTS} it is not for production
 * images and may be removed without notice. It takes a directory holding
 * `skill/`, which replaces the installed plugin's `group-messaging` skill
 * directory wholesale, so the skill's name, description and body may all
 * change while its path stays the one the plugin manifest lists.
 *
 * The tag suffix carries a hash of the directory's content, so two
 * candidates never share a tag.
 */
export const GUIDANCE_DIRECTORY_FLAG = "--experiment-guidance-dir";

/**
 * A guidance candidate read from its directory.
 * @typedef {{directory: string, hash: string}} GuidanceOverride
 */

/**
 * Separate the experiment flags from the shared image-build arguments.
 * @param {readonly string[]} args Process arguments after the script path.
 * @returns {{experiments: string[], guidanceDirectory: string | undefined, buildArguments: string[]}}
 * The experiment flags in {@link OPENCLAW_EXPERIMENTS} order, the
 * {@link GUIDANCE_DIRECTORY_FLAG} value if given, and every other argument.
 */
export function splitExperimentArguments(args) {
  const guidanceIndexes = args.flatMap((arg, index) =>
    arg === GUIDANCE_DIRECTORY_FLAG ? [index] : [],
  );
  if (guidanceIndexes.length > 1) {
    throw new TypeError(GUIDANCE_DIRECTORY_FLAG + " may be given once");
  }
  const guidanceIndex = guidanceIndexes[0];
  const guidanceDirectory =
    guidanceIndex === undefined ? undefined : args[guidanceIndex + 1];
  if (
    guidanceIndex !== undefined &&
    (guidanceDirectory === undefined || guidanceDirectory.startsWith("--"))
  ) {
    throw new TypeError(GUIDANCE_DIRECTORY_FLAG + " needs a directory");
  }
  const remaining = args.filter(
    (_arg, index) => index !== guidanceIndex && index !== guidanceIndex + 1,
  );
  return {
    experiments: Object.keys(OPENCLAW_EXPERIMENTS).filter((flag) =>
      remaining.includes(flag),
    ),
    guidanceDirectory,
    buildArguments: remaining.filter(
      (arg) => !Object.hasOwn(OPENCLAW_EXPERIMENTS, arg),
    ),
  };
}

/**
 * Read a guidance candidate directory and hash its content.
 * @param {string} directory The {@link GUIDANCE_DIRECTORY_FLAG} value.
 * @returns {Promise<GuidanceOverride>} What it holds and a twelve hex
 * character hash of every file's relative path and content.
 */
export async function readGuidanceDirectory(directory) {
  const entries = (await readdir(directory)).sort();
  if (entries.length !== 1 || entries[0] !== "skill") {
    throw new TypeError(
      "guidance directory must hold skill/ alone, not " +
        (entries.length === 0 ? "nothing" : entries.join(", ")),
    );
  }
  const skillFile = await stat(join(directory, "skill", "SKILL.md")).catch(
    () => undefined,
  );
  if (skillFile?.isFile() !== true) {
    throw new TypeError("guidance skill/ must hold SKILL.md");
  }
  const files = (
    await readdir(directory, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file + "\0");
    hash.update(await readFile(join(directory, file)));
  }
  return { directory, hash: hash.digest("hex").slice(0, 12) };
}

/** The Dockerfile lines that install a guidance candidate's skill. */
const GUIDANCE_DOCKERFILE_LINES = [
  "RUN rm -r " + GROUP_MESSAGING_SKILL_PATH,
  "COPY guidance/skill/ " + GROUP_MESSAGING_SKILL_PATH + "/",
];

/**
 * @param {string} dockerfile The source Dockerfile text.
 * @param {readonly string[]} experiments Selected experiment flags.
 * @param {GuidanceOverride} [guidance] The selected guidance candidate.
 * @returns {string} The Dockerfile to stage.
 */
export function experimentDockerfile(dockerfile, experiments, guidance) {
  if (
    guidance !== undefined &&
    experiments.includes("--experiment-omit-collectives-skill")
  ) {
    throw new TypeError(
      "--experiment-omit-collectives-skill cannot be combined with a guidance skill/",
    );
  }
  const lines = [
    ...experiments.map((flag) => OPENCLAW_EXPERIMENTS[flag].dockerfileLine),
    ...(guidance === undefined ? [] : GUIDANCE_DOCKERFILE_LINES),
  ];
  if (lines.length === 0) {
    return dockerfile;
  }
  return (
    dockerfile.replace(/\n?$/u, "\n") +
    lines.map((line) => line + "\n").join("")
  );
}

/**
 * @param {string} tag The fingerprint or the caller's tag.
 * @param {readonly string[]} experiments Selected experiment flags.
 * @param {GuidanceOverride} [guidance] The selected guidance candidate.
 * @returns {string} The tag with one suffix per experiment.
 */
export function experimentTag(tag, experiments, guidance) {
  const suffixed = [
    tag,
    ...experiments.map((flag) => OPENCLAW_EXPERIMENTS[flag].tagSuffix),
    ...(guidance === undefined ? [] : ["guidance-" + guidance.hash]),
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
 * @param {GuidanceOverride | undefined} guidance The selected guidance candidate.
 * @returns {Promise<void>}
 */
async function stageDockerfile(root, experiments, guidance) {
  const dockerfile = await readFile(join(imageRoot, "Dockerfile"), "utf8");
  await writeFile(
    join(root, "Dockerfile"),
    experimentDockerfile(dockerfile, experiments, guidance),
  );
}

/**
 * Copy a guidance candidate into `guidance/` of the staging directory.
 * @param {string} root Staging directory.
 * @param {GuidanceOverride | undefined} guidance The selected guidance candidate.
 * @returns {Promise<void>}
 */
async function stageGuidance(root, guidance) {
  if (guidance !== undefined) {
    await cp(guidance.directory, join(root, "guidance"), { recursive: true });
  }
}

async function stage(experiments, guidance) {
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
    stageDockerfile(root, experiments, guidance),
    stageGuidance(root, guidance),
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
  const { experiments, guidanceDirectory, buildArguments } =
    splitExperimentArguments(process.argv.slice(2));
  const guidance =
    guidanceDirectory === undefined
      ? undefined
      : await readGuidanceDirectory(resolve(guidanceDirectory));
  const options = parseImageBuildArguments(buildArguments, {
    script: "build-openclaw-image.mjs",
    label: "OpenClaw image",
    defaultRepository: DEFAULT_REPOSITORY,
  });
  const staging = await stage(experiments, guidance);
  try {
    const image =
      options.repository +
      ":" +
      experimentTag(
        options.tag ?? (await fingerprint(staging)),
        experiments,
        guidance,
      );
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
        ...(guidance === undefined ? {} : { guidance: guidance.hash }),
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
