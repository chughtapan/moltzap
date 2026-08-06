#!/usr/bin/env tsx
/**
 * @file Agent-instruction file gate. Every `AGENTS.md` has a sibling
 * `CLAUDE.md`, and that sibling is a symlink to it — never a copy, never an
 * import stub.
 *
 * This exists because the decision it enforces argues that prose drifts and
 * checks do not, and then left its own central claim as prose. A new package
 * with a hand-written `CLAUDE.md` would diverge from its `AGENTS.md` silently,
 * which is the exact failure the symlink was chosen to prevent.
 *
 * Symlinks are compared by their stored target rather than by resolved
 * content, so a copy whose bytes happen to match today still fails.
 *
 * Exit codes: 0 clean, 1 violations (each printed with its remedy).
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const tracked = (pattern: string): readonly string[] =>
  execFileSync("git", ["-C", repoRoot, "ls-files", pattern], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((p) => p.length > 0);

interface Violation {
  readonly path: string;
  readonly problem: string;
}

const main = (): void => {
  const agentFiles = tracked("*AGENTS.md");
  const violations: Violation[] = [];

  for (const agentFile of agentFiles) {
    const claudeFile = join(dirname(agentFile), "CLAUDE.md");
    const absolute = join(repoRoot, claudeFile);

    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      violations.push({
        path: claudeFile,
        problem: `missing — ${agentFile} has no sibling CLAUDE.md`,
      });
      continue;
    }

    if (!stat.isSymbolicLink()) {
      violations.push({
        path: claudeFile,
        problem: "is a regular file; it must be a symlink to AGENTS.md",
      });
      continue;
    }

    const target = readlinkSync(absolute);
    if (target !== "AGENTS.md") {
      violations.push({
        path: claudeFile,
        problem: `points at \`${target}\`, not the sibling \`AGENTS.md\``,
      });
    }
  }

  if (violations.length === 0) {
    console.log(
      `[check-agent-files] PASS — ${agentFiles.length} AGENTS.md file(s), each with a CLAUDE.md symlink.`,
    );
    process.exit(0);
  }

  console.error("[check-agent-files] FAIL\n");
  for (const v of violations) {
    console.error(`  ${v.path}`);
    console.error(`    ${v.problem}`);
    console.error(
      "    → fix with: git rm --cached <path> && rm <path> && " +
        "ln -s AGENTS.md <path> && git add <path>\n",
    );
  }
  process.exit(1);
};

main();
