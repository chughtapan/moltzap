#!/usr/bin/env tsx
/**
 * @file Decision-record shape gate. Checks the mechanical rules the
 * `decisions` skill states for `docs/decisions/`, so review can spend its attention on whether
 * a decision is right rather than whether it is well-formed.
 *
 * Two modes:
 *   (no args)  every record — wired into `pnpm lint`.
 *   --staged   only records staged for commit, plus the changelog rule, which
 *              needs a diff to evaluate. Wired into `.husky/pre-commit`, which
 *              invokes it only when staged paths touch the decision trees, so
 *              an ordinary commit pays nothing.
 *
 * The changelog rule is the one with teeth. The `decisions` skill forbids silently
 * rewriting an admitted decision, and allows a point correction — a moved
 * path, a renamed term — that appends a dated row to `Record changelog`.
 * A body edit with neither a status change nor a new row is exactly the
 * silent rewrite the rule exists to prevent, and it is invisible in review
 * because it looks like a typo fix.
 *
 * What it deliberately cannot check: whether a Decision Outcome is correct,
 * whether a changelog row honestly describes its edit, or whether an excerpt
 * was faithfully quoted. Those need a reader.
 *
 * Exit codes: 0 clean, 1 violations (each printed with its remedy).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const git = (args: readonly string[]): string =>
  execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });

const DECISIONS = "docs/decisions";
const EVIDENCE = "docs/decision-evidence";
const STATUSES = ["accepted", "partially-superseded", "superseded"] as const;
const FILENAME = /^(\d{8})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const REQUIRED_SECTIONS = [
  "Context and Problem Statement",
  "Decision Outcome",
  "Consequences",
] as const;

interface Violation {
  readonly record: string;
  readonly problem: string;
  readonly remedy: string;
}

/**
 * Markdown links in this corpus wrap across lines, so every pattern that
 * spans a link must run against whitespace-collapsed text. A line-anchored
 * regex silently reports a missing link for a record that has one.
 */
const collapse = (text: string): string => text.replace(/\s*\n\s*/g, " ");

/** GitHub's heading-to-anchor slug, close enough for link checking. */
const slug = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_[\]()]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");

const frontmatterField = (text: string, key: string): string | undefined =>
  new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text)?.[1]?.trim();

const recordFiles = (): readonly string[] =>
  git(["ls-files", `${DECISIONS}/*.md`])
    .split("\n")
    .filter((p) => p.length > 0 && !p.endsWith("README.md"));

/**
 * Check one record against the mechanical rules.
 *
 * `isNew` gates the required-sections rule. The `decisions` skill requires the
 * three sections of *new* records and says older admitted records retain their
 * historical body shape; 26 of the existing 48 carry consequences as a
 * paragraph inside Decision Outcome, which that clause permits. Enforcing the
 * heading on them would be this gate overruling the rule it implements.
 */
const checkRecord = (
  path: string,
  indexBody: string,
  isNew: boolean,
): Violation[] => {
  const name = path.slice(DECISIONS.length + 1);
  const out: Violation[] = [];
  const add = (problem: string, remedy: string): void => {
    out.push({ record: name, problem, remedy });
  };

  const filename = FILENAME.exec(name);
  if (!filename) {
    add(
      "filename is not YYYYMMDD-short-kebab-title.md",
      "rename it; dates avoid the merge collisions sequence numbers cause",
    );
  }

  const text = readFileSync(join(repoRoot, path), "utf8");
  const joined = collapse(text);

  const date = frontmatterField(text, "date");
  if (!date) add("frontmatter has no `date`", "add `date: YYYY-MM-DD`");
  else if (filename && date.replace(/-/g, "") !== filename[1]) {
    add(
      `frontmatter date ${date} disagrees with the filename`,
      "make them match; the filename date is the record's identity",
    );
  }

  const status = frontmatterField(text, "status");
  if (!status)
    add("frontmatter has no `status`", "add one of: " + STATUSES.join(", "));
  else if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
    add(
      `status \`${status}\` is not a permitted value`,
      "use one of: " + STATUSES.join(", "),
    );
  }

  if (!frontmatterField(text, "decision-makers")) {
    add(
      "frontmatter has no `decision-makers`",
      "name the humans accountable for the call",
    );
  }

  if (isNew) {
    for (const section of REQUIRED_SECTIONS) {
      if (!new RegExp(`^#{2,3}\\s+${section}\\s*$`, "m").test(text)) {
        add(
          `no \`${section}\` section`,
          "add it; a cold reader needs all three",
        );
      }
    }
  }

  const link =
    /Decision provenance:.*?\]\((\.\.\/decision-evidence\/[^)]+)\)/.exec(
      joined,
    );
  if (!link) {
    add(
      "no `Decision provenance` link to a compacted trajectory",
      `link a source-event ledger under ${EVIDENCE}/`,
    );
  } else {
    const [target, anchor] = link[1].replace("../", "").split("#");
    const evidencePath = join(repoRoot, "docs", target);
    if (!existsSync(evidencePath)) {
      add(`provenance target \`${target}\` does not exist`, "fix the path");
    } else if (anchor) {
      const evidence = readFileSync(evidencePath, "utf8");
      const headings = new Set(
        [...evidence.matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) => slug(m[1])),
      );
      if (!evidence.includes(`id="${anchor}"`) && !headings.has(anchor)) {
        add(
          `provenance anchor \`#${anchor}\` resolves to nothing`,
          "a dangling anchor makes the citation unverifiable",
        );
      }
    }
  }

  if (status === "superseded" || status === "partially-superseded") {
    if (!frontmatterField(text, "superseded-by")) {
      add(
        `status is \`${status}\` but there is no \`superseded-by\``,
        "name the replacement",
      );
    }
    if (!/^##\s+Supersession\s*$/m.test(text)) {
      add(
        `status is \`${status}\` but there is no \`Supersession\` section`,
        "say what remains current, what was replaced, and where the contract now lives",
      );
    }
  }

  if (!indexBody.includes(`(${name})`)) {
    add(
      "no row in docs/decisions/README.md",
      "add one; the index is how a cold reader finds this record",
    );
  }

  return out;
};

/**
 * Whether a record matches the side being merged in. A merge adopts the other
 * parent's record verbatim, and comparing against the first parent alone reads
 * that as an unexplained rewrite; the receipt for such an edit belongs to
 * whichever branch authored it, not to the commit that inherits it.
 */
const matchesMergeParent = (path: string, current: string): boolean => {
  try {
    return (
      execFileSync("git", ["-C", repoRoot, "show", `MERGE_HEAD:${path}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }) === current
    );
  } catch {
    return false; // no merge under way, or the record is absent on that side
  }
};

/**
 * A staged record whose body changed, whose status did not, and which gained
 * no changelog row. The `decisions` skill permits editing a record in place
 * only with a dated receipt.
 *
 * `git show` stderr is silenced: a record new in this commit makes it fail by
 * design, and "exists on disk, but not in HEAD" reads like a gate failure.
 */
const checkChangelogRow = (path: string): Violation | undefined => {
  const name = path.slice(DECISIONS.length + 1);
  let previous: string;
  try {
    previous = execFileSync("git", ["-C", repoRoot, "show", `HEAD:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined; // new record; nothing to have rewritten
  }
  const current = readFileSync(join(repoRoot, path), "utf8");
  if (current === previous) return undefined;
  if (matchesMergeParent(path, current)) return undefined;

  if (
    frontmatterField(current, "status") !== frontmatterField(previous, "status")
  ) {
    return undefined; // a status change is a supersession, reviewed on its own terms
  }

  const rows = (t: string): number =>
    (/^##\s+Record changelog\s*$/m.test(t)
      ? (t.split(/^##\s+Record changelog\s*$/m)[1] ?? "").match(
          /^\|\s*\d{4}-\d{2}-\d{2}\s*\|/gm,
        )?.length
      : 0) ?? 0;

  if (rows(current) > rows(previous)) return undefined;

  return {
    record: name,
    problem:
      "body changed, status did not, and no `Record changelog` row was added",
    remedy:
      "append a dated row saying what moved and why the Decision Outcome is untouched — " +
      "without it the edit is indistinguishable from a silent rewrite",
  };
};

/**
 * Only a record added in this commit counts as new; a modified one keeps
 * whatever body shape it was admitted with.
 */
const main = (): void => {
  const staged = process.argv.includes("--staged");
  const indexBody = readFileSync(
    join(repoRoot, DECISIONS, "README.md"),
    "utf8",
  );

  const isRecord = (p: string): boolean =>
    p.startsWith(`${DECISIONS}/`) &&
    p.endsWith(".md") &&
    !p.endsWith("README.md");

  const added = new Set<string>();
  let targets: readonly string[];
  if (staged) {
    const entries = git([
      "diff",
      "--cached",
      "--name-status",
      "--diff-filter=ACMR",
    ])
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => l.split("\t"));
    for (const [flag, path] of entries) {
      if (path && isRecord(path) && flag?.startsWith("A")) added.add(path);
    }
    targets = entries
      .map(([, p]) => p)
      .filter((p): p is string => Boolean(p) && isRecord(p));
  } else {
    targets = recordFiles();
  }

  if (targets.length === 0) {
    console.log("[check-adr-shape] no records to check.");
    process.exit(0);
  }

  const violations = targets.flatMap((p) =>
    checkRecord(p, indexBody, added.has(p)),
  );
  if (staged) {
    violations.push(
      ...targets.map(checkChangelogRow).filter((v) => v !== undefined),
    );
  }

  if (violations.length === 0) {
    console.log(
      `[check-adr-shape] PASS — ${targets.length} record(s) well-formed.`,
    );
    process.exit(0);
  }

  console.error(`[check-adr-shape] FAIL — ${violations.length} problem(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.record}`);
    console.error(`    ${v.problem}`);
    console.error(`    → ${v.remedy}\n`);
  }
  process.exit(1);
};

main();
