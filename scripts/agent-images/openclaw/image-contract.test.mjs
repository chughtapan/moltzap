/** @file The OpenClaw image ships the host script its host command names, runs only a digest-verified Claude Code binary, denies the Claude Code tool that waits for a person, and patches the OpenClaw dist before the plugin installs against it. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { test } from "node:test";
import {
  CLAUDE_CODE_SHA256,
  CLAUDE_CODE_VERSION,
  FINGERPRINTED_FILES,
} from "../build-openclaw-image.mjs";

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

test("the image's managed Claude Code settings deny the tool that waits for a person", async () => {
  const settings = JSON.parse(
    await sibling("claude-code-managed-settings.json"),
  );
  assert.deepEqual(settings, {
    env: { ENABLE_TOOL_SEARCH: "false" },
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
