/** @file The OpenClaw image ships the host script its host command names and runs only a digest-verified Claude Code binary. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { test } from "node:test";
import {
  CLAUDE_CODE_SHA256,
  CLAUDE_CODE_VERSION,
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
