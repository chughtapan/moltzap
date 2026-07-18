#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EFFECT_REPOSITORY_URL = "https://github.com/Effect-TS/effect.git";
export const EFFECT_TAG = "effect@3.22.0";
export const EFFECT_COMMIT = "e670e0f6befb959b84208d5f77631276521020ae";

export const WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

const pathExists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const runGit = (cwd, args) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `git ${args.join(" ")} failed with exit ${result.status}${detail === "" ? "" : `: ${detail}`}`,
    );
  }

  return result.stdout.trim();
};

export class EffectSourceMismatchError extends Error {
  constructor(checkoutDir, mismatches) {
    super(
      `Effect source checkout mismatch at ${checkoutDir}:\n${mismatches
        .map((mismatch) => `- ${mismatch}`)
        .join(
          "\n",
        )}\nMove the existing checkout out of the way, then rerun pnpm prepare. The bootstrap never modifies a mismatched checkout.`,
    );
    this.name = "EffectSourceMismatchError";
  }
}

export const effectSourcePath = (workspaceRoot = WORKSPACE_ROOT) =>
  join(workspaceRoot, ".repos", "effect");

/**
 * Verify an Effect checkout without fetching, resetting, or otherwise
 * modifying it.
 */
export const verifyEffectCheckout = ({
  checkoutDir,
  repositoryUrl = EFFECT_REPOSITORY_URL,
  tag = EFFECT_TAG,
  commit = EFFECT_COMMIT,
}) => {
  const mismatches = [];

  let isWorkTree;
  try {
    isWorkTree = runGit(checkoutDir, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    throw new EffectSourceMismatchError(checkoutDir, [
      `not a readable Git worktree (${errorMessage(error)})`,
    ]);
  }

  if (isWorkTree !== "true") {
    throw new EffectSourceMismatchError(checkoutDir, [
      `expected a Git worktree, found rev-parse result ${JSON.stringify(isWorkTree)}`,
    ]);
  }

  let origin;
  try {
    origin = runGit(checkoutDir, ["remote", "get-url", "origin"]);
  } catch (error) {
    mismatches.push(`origin could not be verified (${errorMessage(error)})`);
  }
  if (origin !== undefined && origin !== repositoryUrl) {
    mismatches.push(
      `origin expected ${JSON.stringify(repositoryUrl)}, found ${JSON.stringify(origin)}`,
    );
  }

  let head;
  try {
    head = runGit(checkoutDir, ["rev-parse", "HEAD"]);
  } catch (error) {
    mismatches.push(`HEAD could not be verified (${errorMessage(error)})`);
  }
  if (head !== undefined && head !== commit) {
    mismatches.push(
      `HEAD expected ${JSON.stringify(commit)}, found ${JSON.stringify(head)}`,
    );
  }

  let taggedCommit;
  try {
    taggedCommit = runGit(checkoutDir, [
      "rev-parse",
      "--verify",
      `${tag}^{commit}`,
    ]);
  } catch (error) {
    mismatches.push(
      `tag ${JSON.stringify(tag)} could not be verified (${errorMessage(error)})`,
    );
  }
  if (taggedCommit !== undefined && taggedCommit !== commit) {
    mismatches.push(
      `tag ${JSON.stringify(tag)} expected ${JSON.stringify(commit)}, found ${JSON.stringify(taggedCommit)}`,
    );
  }

  if (mismatches.length > 0) {
    throw new EffectSourceMismatchError(checkoutDir, mismatches);
  }

  return { checkoutDir, origin, head, tag, taggedCommit };
};

/**
 * Atomically promote a verified temporary clone. If another prepare wins the
 * race, accept only an exact checkout and let the caller clean up its temp.
 */
export const promoteEffectCheckout = ({
  tempDir,
  checkoutDir,
  repositoryUrl = EFFECT_REPOSITORY_URL,
  tag = EFFECT_TAG,
  commit = EFFECT_COMMIT,
}) => {
  try {
    renameSync(tempDir, checkoutDir);
    return "cloned";
  } catch (error) {
    if (!pathExists(checkoutDir)) throw error;
    verifyEffectCheckout({ checkoutDir, repositoryUrl, tag, commit });
    return "existing";
  }
};

export const prepareEffectSource = ({
  workspaceRoot = WORKSPACE_ROOT,
  repositoryUrl = EFFECT_REPOSITORY_URL,
  tag = EFFECT_TAG,
  commit = EFFECT_COMMIT,
  env = process.env,
  logger = console.log,
} = {}) => {
  const checkoutDir = effectSourcePath(workspaceRoot);

  if (env.MOLTZAP_SKIP_EFFECT_SOURCE === "1") {
    logger("Skipping Effect source bootstrap (MOLTZAP_SKIP_EFFECT_SOURCE=1).");
    return { status: "skipped", checkoutDir };
  }

  if (pathExists(checkoutDir)) {
    verifyEffectCheckout({ checkoutDir, repositoryUrl, tag, commit });
    logger(`Effect source already prepared at ${checkoutDir}.`);
    return { status: "existing", checkoutDir };
  }

  const reposDir = dirname(checkoutDir);
  mkdirSync(reposDir, { recursive: true });
  const tempDir = mkdtempSync(join(reposDir, ".effect.tmp-"));
  let ownsTemp = true;
  let status;

  try {
    runGit(reposDir, [
      "clone",
      "--depth",
      "1",
      "--branch",
      tag,
      "--single-branch",
      "--",
      repositoryUrl,
      tempDir,
    ]);
    verifyEffectCheckout({
      checkoutDir: tempDir,
      repositoryUrl,
      tag,
      commit,
    });
    status = promoteEffectCheckout({
      tempDir,
      checkoutDir,
      repositoryUrl,
      tag,
      commit,
    });
    ownsTemp = status !== "cloned";
  } finally {
    if (ownsTemp) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  logger(
    status === "cloned"
      ? `Prepared Effect source ${tag} at ${checkoutDir}.`
      : `Effect source already prepared at ${checkoutDir}.`,
  );
  return { status, checkoutDir };
};

export const runCli = () => {
  try {
    prepareEffectSource();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
};

const invokedPath =
  process.argv[1] === undefined ? undefined : resolve(process.argv[1]);

if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli();
}
