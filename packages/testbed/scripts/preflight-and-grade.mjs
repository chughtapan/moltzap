#!/usr/bin/env node
/**
 * The grading recipe: refuse, then judge.
 *
 * Stage 1 is preflight. It runs `recording check` with the caller's
 * content key and the completed-run requirement, so a recording that is
 * unsealed (10), the wrong schema version (11), undecodable (12),
 * produced from different content (13), or from a run that never
 * completed (14) is refused before any grader starts. Stage 2 invokes the
 * grader, whose exit codes are its own.
 *
 * The split is the point. Without stage 1 a suite of runs that all timed
 * out is byte-identical to a suite of agents that answered and failed the
 * rubric, because both arrive as the grader's "fail". The refusal keeps
 * invalidity out of the verdict channel.
 *
 * Usage:
 *   preflight-and-grade.mjs <recording-dir> [--content-version <key>]
 *                           [--grade <command...>]
 *
 * Exit: the preflight code when preflight refuses; otherwise the
 * grader's own exit code. With no --grade, it preflights and stops.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(
  fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
);

function parse(argv) {
  const [recording, ...rest] = argv;
  let contentVersion;
  const grade = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--content-version") {
      contentVersion = rest[index + 1];
      index += 1;
    } else if (rest[index] === "--grade") {
      grade.push(...rest.slice(index + 1));
      break;
    }
  }
  return { recording, contentVersion, grade };
}

const { recording, contentVersion, grade } = parse(process.argv.slice(2));

if (recording === undefined) {
  process.stderr.write(
    "usage: preflight-and-grade.mjs <recording-dir> [--content-version <key>] [--grade <command...>]\n",
  );
  process.exit(2);
}

// Stage 1 — preflight.
const checkArgs = [CLI, "recording", "check", recording, "--require-completed", "--json"];
if (contentVersion !== undefined) {
  checkArgs.push("--content-version", contentVersion);
}
const preflight = spawnSync(process.execPath, checkArgs, { encoding: "utf8" });
process.stdout.write(preflight.stdout ?? "");
if (preflight.status !== 0) {
  process.stderr.write(
    `preflight refused ${recording} (exit ${preflight.status}); no grader was invoked\n`,
  );
  process.exit(preflight.status ?? 1);
}

if (grade.length === 0) {
  process.exit(0);
}

// Stage 2 — the grader, with its own exit semantics.
const graded = spawnSync(grade[0], grade.slice(1), {
  encoding: "utf8",
  stdio: "inherit",
});

// The reproducibility sidecar. Unchanged grader artifacts cannot carry
// these fields, so the recipe that ran both stages writes them down.
const meta = {
  recording: resolve(recording),
  contentVersion: contentVersion ?? null,
  preflight: JSON.parse(preflight.stdout || "{}"),
  grader: grade.join(" "),
  rubricSha256: createHash("sha256")
    .update(JSON.stringify(grade))
    .digest("hex"),
  gradedAtWallTime: Date.now(),
};
writeFileSync(
  join(resolve(recording), "grading-meta.json"),
  `${JSON.stringify(meta, null, 2)}\n`,
  "utf8",
);

process.exit(graded.status ?? 1);
