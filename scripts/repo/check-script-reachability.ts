#!/usr/bin/env tsx
/**
 * @file Script-reachability gate. Every file under `scripts/` must be
 * reachable from something a person or a machine actually runs: a
 * `package.json` script, an Nx target, a git hook, a CI workflow, a
 * sibling script, a test, or prose that documents how to invoke it.
 *
 * Grouping `scripts/` by function is a one-time tidy; without a
 * reachability rule the directory silently refills. Five scripts had no
 * live caller when this gate was written, and one of them — an RPC
 * method-string check — had been a total no-op for long enough that the
 * directories it scanned no longer existed.
 *
 * A reference is any mention of the script's repo-relative path anywhere
 * else in the tracked tree. Prose counts on purpose: a regeneration tool
 * cited by the test that consumes its fixtures is reachable, because a
 * reader can find their way to it.
 *
 * Exit codes:
 *   0 — every script is reachable, and every allowlist entry is still
 *       both present and genuinely unreferenced.
 *   1 — at least one unreachable script, or a stale allowlist entry.
 *
 * Wired into `pnpm lint` via the workspace `lint:script-reachability`
 * target.
 */
import { execFileSync } from "node:child_process";

/**
 * Scripts that are entry points rather than callees. Each needs a reason
 * that says who runs it and when; "it might be useful" is not a reason.
 * The gate fails on a stale entry, so this list cannot rot quietly.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map();

/**
 * Every git call is rooted at the repo, never at the caller's cwd: the Nx
 * target invokes this through `pnpm --filter`, which runs it from inside a
 * package. A cwd-relative `ls-files scripts` silently scans that package's
 * own `scripts/` directory instead of the workspace one.
 */
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const git = (args: readonly string[]): string =>
  execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });

/**
 * `git grep` exits 1 to mean "no match", which `execFileSync` raises as an
 * error. Only that exit code is benign; anything else is a real failure and
 * must not be swallowed into a false "unreferenced" verdict.
 */
const gitGrepFiles = (needle: string): readonly string[] => {
  try {
    return git([
      "grep",
      "--fixed-strings",
      "--files-with-matches",
      needle,
      "--",
      ".",
      ":(exclude)scripts/__tests__",
      // This file names every allowlisted path, so counting it as a reference
      // would make each allowlist entry look self-justifying.
      ":(exclude)scripts/repo/check-script-reachability.ts",
    ]).split("\n");
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
};

const trackedScripts = (): readonly string[] =>
  git(["ls-files", "scripts"])
    .split("\n")
    .filter((p) => p.length > 0 && !p.startsWith("scripts/__tests__/"));

/** True when `path` is mentioned by any tracked file other than itself. */
const isReferenced = (path: string): boolean =>
  gitGrepFiles(path).some((f) => f.length > 0 && f !== path);

const main = (): void => {
  const scripts = trackedScripts();
  const unreachable: string[] = [];
  const staleAllowlist: string[] = [];

  for (const path of scripts) {
    const referenced = isReferenced(path);
    if (ALLOWLIST.has(path)) {
      if (referenced) staleAllowlist.push(path);
      continue;
    }
    if (!referenced) unreachable.push(path);
  }

  for (const path of ALLOWLIST.keys()) {
    if (!scripts.includes(path)) staleAllowlist.push(path);
  }

  if (unreachable.length === 0 && staleAllowlist.length === 0) {
    console.log(
      `[check-script-reachability] PASS — ${scripts.length} script(s) reachable ` +
        `(${ALLOWLIST.size} allowlisted entry point(s)).`,
    );
    process.exit(0);
  }

  console.error("[check-script-reachability] FAIL\n");
  for (const path of unreachable) {
    console.error(`  ${path}`);
    console.error(
      "    → nothing references it. Wire it into package.json, an Nx target, a " +
        "hook, a workflow, or a sibling script; document it where a reader will " +
        "look; or delete it. If it is a standalone entry point, add it to " +
        "ALLOWLIST in this file with a reason.\n",
    );
  }
  for (const path of staleAllowlist) {
    console.error(`  ${path}  [stale allowlist entry]`);
    console.error(
      "    → it is now referenced, or no longer exists. Remove it from " +
        "ALLOWLIST.\n",
    );
  }
  process.exit(1);
};

main();
