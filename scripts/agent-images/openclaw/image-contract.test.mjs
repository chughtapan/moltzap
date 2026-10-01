/** @file The OpenClaw image ships the host script its host command names, runs only a digest-verified Claude Code binary, denies the Claude Code tool that waits for a person, patches the OpenClaw dist before the plugin installs against it, and gives each experiment variant its own tag. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test } from "node:test";
import {
  CLAUDE_CODE_SHA256,
  CLAUDE_CODE_VERSION,
  experimentDockerfile,
  experimentTag,
  FINGERPRINTED_FILES,
  fingerprint,
  GUIDANCE_DIRECTORY_FLAG,
  GUIDANCE_PARAMETERS_PATH,
  OPENCLAW_EXPERIMENTS,
  packageManifest,
  readGuidanceDirectory,
  splitExperimentArguments,
  ZAI_PROVIDER_PATH,
  ZAI_PROVIDER_VERSION,
} from "../build-openclaw-image.mjs";
import { DEFAULT_HOST_FINALIZER } from "../shared/entrypoint.mjs";

const AGENT_DIRECTORY = "/opt/moltzap/agent/";

/**
 * @param {string} name File beside this test.
 * @returns {Promise<string>} Its text.
 */
function sibling(name) {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

/**
 * File names the Dockerfile copies into the agent directory.
 * @param {string} dockerfile Dockerfile text.
 * @returns {string[]} Sources of every `COPY ... /opt/moltzap/agent/` line.
 */
function copiedIntoAgentDirectory(dockerfile) {
  return dockerfile
    .split("\n")
    .filter((line) => line.startsWith("COPY "))
    .map((line) => line.split(/\s+/u).slice(1))
    .filter((words) => words.at(-1) === AGENT_DIRECTORY)
    .flatMap((words) => words.slice(0, -1));
}

test("the host command runs a script the Dockerfile copies into the agent directory", async () => {
  const command = JSON.parse(await sibling("host-command.json"));
  assert.deepEqual(command, ["bash", `${AGENT_DIRECTORY}host.sh`]);

  const copied = copiedIntoAgentDirectory(await sibling("Dockerfile"));
  assert.ok(
    copied.includes(posix.basename(command[1])),
    `Dockerfile copies ${copied.join(", ")} and not the host command's script`,
  );
  assert.ok(copied.includes("host-command.json"));
  await sibling(posix.basename(command[1]));
});

test("the Dockerfile copies the host finalizer to the path the entrypoint runs", async () => {
  const copied = copiedIntoAgentDirectory(await sibling("Dockerfile"));

  assert.equal(posix.dirname(DEFAULT_HOST_FINALIZER) + "/", AGENT_DIRECTORY);
  assert.ok(
    copied.includes(posix.basename(DEFAULT_HOST_FINALIZER)),
    `Dockerfile copies ${copied.join(", ")} and not the host finalizer`,
  );
});

test("the Dockerfile runs only a Claude Code binary that matches the build script's digest", async () => {
  assert.match(CLAUDE_CODE_VERSION, /^\d+\.\d+\.\d+$/u);
  assert.deepEqual(Object.keys(CLAUDE_CODE_SHA256).sort(), ["amd64", "arm64"]);
  for (const digest of Object.values(CLAUDE_CODE_SHA256)) {
    assert.match(digest, /^[a-f0-9]{64}$/u);
  }

  const dockerfile = await sibling("Dockerfile");
  for (const argument of [
    "TARGETARCH",
    "CLAUDE_CODE_VERSION",
    "CLAUDE_CODE_SHA256_AMD64",
    "CLAUDE_CODE_SHA256_ARM64",
  ]) {
    assert.match(dockerfile, new RegExp(`^ARG ${argument}$`, "mu"));
  }
  assert.doesNotMatch(dockerfile, /\|\s*(ba)?sh\b/u);
  const verified = dockerfile.indexOf("| sha256sum -c -");
  const executed = dockerfile.indexOf(
    '/tmp/claude install "${CLAUDE_CODE_VERSION}"',
  );
  assert.ok(verified > 0, "the download is never checked against a digest");
  assert.ok(
    executed > verified,
    "the downloaded binary runs before its digest is checked",
  );

  const build = await readFile(
    new URL("../build-openclaw-image.mjs", import.meta.url),
    "utf8",
  );
  assert.match(build, /"CLAUDE_CODE_VERSION=" \+ CLAUDE_CODE_VERSION/u);
  assert.match(
    build,
    /"CLAUDE_CODE_SHA256_AMD64=" \+ CLAUDE_CODE_SHA256\.amd64/u,
  );
  assert.match(
    build,
    /"CLAUDE_CODE_SHA256_ARM64=" \+ CLAUDE_CODE_SHA256\.arm64/u,
  );
});

test("the Dockerfile patches the OpenClaw dist before the plugin installs against it", async () => {
  const dockerfile = await sibling("Dockerfile");
  assert.ok(
    copiedIntoAgentDirectory(dockerfile).includes("patch-openclaw.mjs"),
  );
  const patched = dockerfile.indexOf(
    `node ${AGENT_DIRECTORY}patch-openclaw.mjs /app/dist`,
  );
  const installed = dockerfile.indexOf("npm install");
  assert.ok(patched > 0, "the patch never runs");
  assert.ok(
    installed > patched,
    "the plugin installs against an unpatched dist",
  );
  assert.match(
    dockerfile,
    new RegExp(`--marker ${AGENT_DIRECTORY}openclaw-patch\\.json`, "u"),
  );
  await sibling("patch-openclaw.mjs");
});

test("the image's managed Claude Code settings deny the tools no agent pod can use", async () => {
  const settings = JSON.parse(
    await sibling("claude-code-managed-settings.json"),
  );
  assert.deepEqual(settings, {
    permissions: { deny: ["AskUserQuestion", "ListAgents", "SendMessage"] },
  });
  assert.match(
    await sibling("Dockerfile"),
    /^COPY claude-code-managed-settings\.json \/etc\/claude-code\/managed-settings\.json$/mu,
  );
});

test("every file the Dockerfile copies from the build context decides the image tag", async () => {
  const copied = (await sibling("Dockerfile"))
    .split("\n")
    .filter((line) => line.startsWith("COPY "))
    .flatMap((line) => line.split(/\s+/u).slice(1, -1))
    .filter((source) => source !== "tarballs");
  assert.ok(copied.includes("claude-code-managed-settings.json"));
  assert.ok(copied.includes("patch-openclaw.mjs"));
  assert.deepEqual(
    copied.filter((source) => !FINGERPRINTED_FILES.includes(source)),
    [],
  );
});

test("the staged manifest pins the native Z.AI provider and fingerprints it", async () => {
  const manifest = packageManifest({ "@moltzap/client": "client.tgz" });
  assert.equal(
    manifest.dependencies["@openclaw/zai-provider"],
    ZAI_PROVIDER_VERSION,
  );
  assert.equal(
    manifest.dependencies["@moltzap/client"],
    "file:./tarballs/client.tgz",
  );
  assert.deepEqual(manifest.overrides, {
    "@moltzap/client": "file:./tarballs/client.tgz",
  });
  assert.equal(
    ZAI_PROVIDER_PATH,
    "/opt/moltzap/node_modules/@openclaw/zai-provider",
  );
  assert.ok(FINGERPRINTED_FILES.includes("package.json"));
  assert.match(
    await sibling("Dockerfile"),
    /import\("@openclaw\/zai-provider\/dist\/index\.js"\)/u,
  );
});

const HIDE = "--experiment-hide-collectives";
const OMIT = "--experiment-omit-collectives-skill";

/**
 * @param {string} dockerfile Dockerfile text to stage.
 * @returns {Promise<string>} The fingerprint of a staging directory holding
 * that Dockerfile and fixed content for every other fingerprinted file.
 */
async function fingerprintWith(dockerfile) {
  const root = await mkdtemp(join(tmpdir(), "moltzap-openclaw-fingerprint-"));
  try {
    await mkdir(join(root, "tarballs"));
    await writeFile(join(root, "tarballs", "channel.tgz"), "tarball");
    await Promise.all(
      FINGERPRINTED_FILES.map((name) =>
        writeFile(
          join(root, name),
          name === "Dockerfile" ? dockerfile : "fixed " + name,
        ),
      ),
    );
    return await fingerprint(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a build without experiment flags stages the Dockerfile and tag unchanged", async () => {
  const dockerfile = await sibling("Dockerfile");

  assert.deepEqual(splitExperimentArguments(["--push", "--tag", "t"]), {
    experiments: [],
    guidanceDirectory: undefined,
    buildArguments: ["--push", "--tag", "t"],
  });
  assert.equal(experimentDockerfile(dockerfile, []), dockerfile);
  assert.equal(experimentTag("0123456789abcdef", []), "0123456789abcdef");
});

test("each experiment variant has its own fingerprint and tag", async () => {
  const dockerfile = await sibling("Dockerfile");
  const variants = [[], [HIDE], [OMIT], [HIDE, OMIT]];
  const fingerprints = await Promise.all(
    variants.map((experiments) =>
      fingerprintWith(experimentDockerfile(dockerfile, experiments)),
    ),
  );
  const tags = variants.map((experiments) =>
    experimentTag("2026.930.0", experiments),
  );

  assert.equal(new Set(fingerprints).size, variants.length);
  assert.deepEqual(tags, [
    "2026.930.0",
    "2026.930.0-hide-collectives",
    "2026.930.0-omit-collectives-skill",
    "2026.930.0-hide-collectives-omit-collectives-skill",
  ]);
});

test("an experiment line starts on its own line and a suffixed tag stays a valid length", () => {
  assert.equal(
    experimentDockerfile("FROM base", [HIDE]),
    "FROM base\nENV MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES=true\n",
  );
  assert.throws(
    () => experimentTag("a".repeat(128), [HIDE]),
    /exceeds 128 characters/u,
  );
});

test("experiment flags are taken in a fixed order whatever the argument order", () => {
  assert.deepEqual(
    splitExperimentArguments([OMIT, "--push", HIDE, "--tag", "constructor"]),
    {
      experiments: [HIDE, OMIT],
      guidanceDirectory: undefined,
      buildArguments: ["--push", "--tag", "constructor"],
    },
  );
});

test("the hide-collectives variant sets the plugin's experiment switch for the host", async () => {
  const plugin = await readFile(
    new URL(
      "../../../packages/openclaw-channel/src/plugin.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(
    OPENCLAW_EXPERIMENTS[HIDE].dockerfileLine,
    "ENV MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES=true",
  );
  assert.match(
    plugin,
    /^const HIDE_COLLECTIVES_VARIABLE = "MOLTZAP_EXPERIMENT_HIDE_COLLECTIVES";$/mu,
  );
});

test("the omit-skill variant deletes the installed plugin's collectives skill directory", async () => {
  const channel = new URL(
    "../../../packages/openclaw-channel/",
    import.meta.url,
  );
  const manifest = JSON.parse(
    await readFile(new URL("openclaw.plugin.json", channel), "utf8"),
  );

  assert.equal(
    OPENCLAW_EXPERIMENTS[OMIT].dockerfileLine,
    "RUN rm -r /opt/moltzap/node_modules/@moltzap/openclaw-channel/skills/moltzap-collectives",
  );
  assert.deepEqual(manifest.skills, ["./skills"]);
  await readFile(
    new URL("skills/moltzap-collectives/SKILL.md", channel),
    "utf8",
  );
  assert.ok(
    (await sibling("Dockerfile")).indexOf("npm install") > 0,
    "the plugin must be installed before an appended line deletes its skill",
  );
});

/**
 * Run a check against a fresh guidance directory holding the given files.
 * @param {Record<string, string>} files Content by path relative to the directory.
 * @param {(directory: string) => Promise<void>} check The check to run.
 * @returns {Promise<void>}
 */
async function withGuidance(files, check) {
  const directory = await mkdtemp(join(tmpdir(), "moltzap-guidance-dir-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(posix.dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), content);
    }
    await check(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const SKILL = {
  "skill/SKILL.md": "---\nname: moltzap-collectives\n---\nBody\n",
};
const PARAMETERS = { "parameters.json": '{"collective":"Gather answers."}' };

test("the guidance flag takes its directory out of the build arguments beside the other flags", () => {
  assert.deepEqual(
    splitExperimentArguments([
      "--tag",
      "t",
      GUIDANCE_DIRECTORY_FLAG,
      "candidates/one",
      HIDE,
    ]),
    {
      experiments: [HIDE],
      guidanceDirectory: "candidates/one",
      buildArguments: ["--tag", "t"],
    },
  );
  assert.throws(
    () => splitExperimentArguments([GUIDANCE_DIRECTORY_FLAG]),
    /needs a directory/u,
  );
  assert.throws(
    () => splitExperimentArguments([GUIDANCE_DIRECTORY_FLAG, "--push"]),
    /needs a directory/u,
  );
  assert.throws(
    () =>
      splitExperimentArguments([
        GUIDANCE_DIRECTORY_FLAG,
        "a",
        GUIDANCE_DIRECTORY_FLAG,
        "b",
      ]),
    /may be given once/u,
  );
});

test("a guidance skill replaces the installed collectives skill directory", async () => {
  await withGuidance(SKILL, async (directory) => {
    const guidance = await readGuidanceDirectory(directory);

    assert.equal(guidance.skill, true);
    assert.equal(guidance.parameters, false);
    assert.equal(
      experimentDockerfile("FROM base", [], guidance),
      "FROM base\n" +
        "RUN rm -r /opt/moltzap/node_modules/@moltzap/openclaw-channel/skills/moltzap-collectives\n" +
        "COPY guidance/skill/ /opt/moltzap/node_modules/@moltzap/openclaw-channel/skills/moltzap-collectives/\n",
    );
    assert.throws(
      () => experimentDockerfile("FROM base", [OMIT], guidance),
      /cannot be combined/u,
    );
  });
});

test("a guidance parameters file is copied, named by the plugin's switch, and loaded at build", async () => {
  const plugin = await readFile(
    new URL(
      "../../../packages/openclaw-channel/src/plugin.ts",
      import.meta.url,
    ),
    "utf8",
  );
  await withGuidance(PARAMETERS, async (directory) => {
    const guidance = await readGuidanceDirectory(directory);
    const lines = experimentDockerfile("FROM base", [], guidance).split("\n");

    assert.deepEqual(lines.slice(1, 3), [
      `COPY guidance/parameters.json ${GUIDANCE_PARAMETERS_PATH}`,
      `ENV MOLTZAP_EXPERIMENT_GUIDANCE_PARAMETERS=${GUIDANCE_PARAMETERS_PATH}`,
    ]);
    assert.match(
      lines[3],
      /^RUN node .*import\("\/opt\/moltzap\/node_modules\/@moltzap\/openclaw-channel\/dist\/index\.js"\)/u,
    );
  });
  assert.match(
    plugin,
    /^const GUIDANCE_PARAMETERS_VARIABLE =\s+"MOLTZAP_EXPERIMENT_GUIDANCE_PARAMETERS";$/mu,
  );
});

test("each guidance candidate has its own tag suffix", async () => {
  const hashes = [];
  for (const files of [
    SKILL,
    PARAMETERS,
    { ...SKILL, ...PARAMETERS },
    { ...SKILL, "skill/SKILL.md": "---\nname: other\n---\nBody\n" },
    { ...SKILL, "skill/notes.md": "extra" },
  ]) {
    await withGuidance(files, async (directory) => {
      hashes.push((await readGuidanceDirectory(directory)).hash);
    });
  }
  await withGuidance(SKILL, async (directory) => {
    const guidance = await readGuidanceDirectory(directory);
    assert.equal(guidance.hash, hashes[0]);
    assert.equal(
      experimentTag("t", [HIDE], guidance),
      `t-hide-collectives-guidance-${guidance.hash}`,
    );
  });

  assert.equal(new Set(hashes).size, hashes.length);
  assert.ok(hashes.every((hash) => /^[0-9a-f]{12}$/u.test(hash)));
});

test("a guidance directory holds only a skill with SKILL.md and a parameters file", async () => {
  for (const files of [
    {},
    { ...PARAMETERS, "notes.md": "x" },
    { "skill/README.md": "x" },
  ]) {
    await withGuidance(files, (directory) =>
      assert.rejects(readGuidanceDirectory(directory)),
    );
  }
});
