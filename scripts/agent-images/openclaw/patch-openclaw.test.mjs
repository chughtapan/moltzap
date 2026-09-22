/** @file The OpenClaw patch applies once to the pinned dist, reaches both bundles, and refuses a dist it does not recognize. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  applyOpenClawPatch,
  BOT_SENDER_DELIVERY_HINT,
  EDITS,
} from "./patch-openclaw.mjs";

/**
 * The channel plugin's installed OpenClaw. The plugin pins the release the base
 * image carries; the image build is the check against the base image itself.
 */
const installedDist = join(
  fileURLToPath(
    new URL("../../../packages/openclaw-channel/", import.meta.url),
  ),
  "node_modules",
  "openclaw",
  "dist",
);

/**
 * @param {string} text Haystack.
 * @param {string} needle Substring.
 * @returns {number} Non-overlapping occurrences.
 */
function count(text, needle) {
  return text.split(needle).length - 1;
}

/**
 * A temp dist holding only the bundles the patch touches, copied from the
 * installed package.
 * @returns {Promise<string>} Its root; the caller removes it.
 */
async function stagedDist() {
  const root = await mkdtemp(join(tmpdir(), "openclaw-patch-test-"));
  const names = (await readdir(installedDist)).filter((name) =>
    /^(agent-runner\.runtime-|cli-runner-|get-reply-|message-tool-delivery-hints-)[^.]+\.js$/u.test(
      name,
    ),
  );
  await Promise.all(
    names.map((name) => cp(join(installedDist, name), join(root, name))),
  );
  await cp(
    join(installedDist, "worker", "worker.mjs"),
    join(root, "worker", "worker.mjs"),
  );
  return root;
}

/**
 * @param {string} root Directory to read.
 * @returns {Promise<Map<string, string>>} Every file under it, by relative path.
 */
async function snapshot(root) {
  const names = await readdir(root, { recursive: true, withFileTypes: true });
  const files = names
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  return new Map(
    await Promise.all(
      files.map(async (file) => [file, await readFile(file, "utf8")]),
    ),
  );
}

test("every anchor matches once across the five bundles the patch edits", async () => {
  const root = await stagedDist();
  try {
    const applied = await applyOpenClawPatch(root);
    assert.deepEqual(
      applied.map((edit) => edit.id),
      EDITS.map((edit) => edit.id),
    );
    for (const edit of applied) {
      const text = await readFile(join(root, edit.file), "utf8");
      const spec = EDITS.find((candidate) => candidate.id === edit.id);
      assert.equal(count(text, spec.after), 1, `${edit.id}: edit applied once`);
      assert.equal(
        count(text, spec.before),
        count(spec.after, spec.before),
        `${edit.id}: the anchor survives only inside its own replacement`,
      );
    }
    const bundles = new Set(applied.map((edit) => edit.file));
    assert.equal(
      bundles.size,
      5,
      "runner, reply prompt, hint list, CLI runner and worker bundles",
    );
    const worker = await readFile(join(root, "worker", "worker.mjs"), "utf8");
    assert.ok(worker.includes(JSON.stringify(BOT_SENDER_DELIVERY_HINT)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a CLI run's context-sizing usage stays the last streamed record", async () => {
  const root = await stagedDist();
  try {
    const applied = await applyOpenClawPatch(root);
    const runner = applied.find((edit) => edit.id === "cli-run-usage");
    const text = await readFile(join(root, runner.file), "utf8");
    assert.equal(
      count(text, "...output.usage ? { lastCallUsage: output.usage } : {},"),
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a patched dist is refused and left as it was", async () => {
  const root = await stagedDist();
  try {
    await applyOpenClawPatch(root);
    const patched = await snapshot(root);
    await assert.rejects(applyOpenClawPatch(root), /anchors do not match/u);
    assert.deepEqual(await snapshot(root), patched);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dist that carries none of the anchors is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-patch-test-"));
  try {
    await assert.rejects(applyOpenClawPatch(root), /gate: .* found nothing/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an anchor found twice in one file is refused", async () => {
  const root = await stagedDist();
  try {
    const worker = join(root, "worker", "worker.mjs");
    const gate = EDITS.find((edit) => edit.id === "worker-gate");
    await appendFile(worker, gate.before);
    await assert.rejects(
      applyOpenClawPatch(root),
      /worker-gate: expected the anchor once in one file, found .+ x2/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an anchor found in two files is refused", async () => {
  const root = await stagedDist();
  try {
    await cp(
      join(root, "worker", "worker.mjs"),
      join(root, "worker", "copy.mjs"),
    );
    await assert.rejects(
      applyOpenClawPatch(root),
      /worker-gate: expected the anchor once in one file, found .+ x1, .+ x1/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the command writes the marker it is given and refuses a call without a dist", async () => {
  const script = fileURLToPath(
    new URL("./patch-openclaw.mjs", import.meta.url),
  );
  const run = promisify(execFile);
  const root = await stagedDist();
  try {
    const marker = join(root, "marker", "openclaw-patch.json");
    const { stdout } = await run(process.execPath, [
      script,
      root,
      "--base-image",
      "example/openclaw@sha256:0",
      "--marker",
      marker,
    ]);
    assert.match(stdout, new RegExp(`applied ${EDITS.length} edits`, "u"));
    const written = JSON.parse(await readFile(marker, "utf8"));
    assert.equal(written.baseImage, "example/openclaw@sha256:0");
    assert.deepEqual(
      written.edits.map((edit) => edit.id),
      EDITS.map((edit) => edit.id),
    );
    await assert.rejects(
      run(process.execPath, [script]),
      /usage: patch-openclaw/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dry run reports the edits and leaves the bundles unchanged", async () => {
  const root = await stagedDist();
  try {
    const before = await snapshot(root);
    const applied = await applyOpenClawPatch(root, { dryRun: true });
    assert.equal(applied.length, EDITS.length);
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every anchor is unique across the whole installed dist", async () => {
  const applied = await applyOpenClawPatch(installedDist, { dryRun: true });
  assert.equal(applied.length, EDITS.length);
});
