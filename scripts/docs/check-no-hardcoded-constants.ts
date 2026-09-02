#!/usr/bin/env tsx
/**
 * @file Drift gate for hardcoded MoltZap compatibility values in doc copy.
 *
 * The companion to `scripts/docs/generate-constants-snippets.ts`: that
 * script writes `docs/snippets/constants/values.{mdx,json}` from the
 * authoritative source files; this script scans every other doc for
 * literal occurrences of those values. A match outside the constants
 * snippet (or an explicit allowlist of auto-generated trees) is a
 * fail — the doc must `import` the value from the snippet instead.
 *
 * The exact `V2_PROTOCOL_VERSION` value comes from
 * `docs/snippets/constants/values.json`.
 *
 * Plus a structural sweep for any other version-shaped literal
 * `\d{4}\.\d{3,4}\.\d+` in `docs/`, to catch new doc drift before
 * it ships.
 *
 * Exit codes:
 *   0 — no violations.
 *   1 — at least one literal found outside the allowlist; details
 *       printed with `file:line` + the constant it should be sourced
 *       from.
 *
 * Wired into `pnpm docs:check:no-hardcoded-constants`; called by
 * `pnpm docs:check:drift` for additive coverage.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..", "..");
const docsDir = resolve(workspaceRoot, "docs");
const valuesJsonPath = resolve(docsDir, "snippets", "constants", "values.json");

// ─── Allowlist ────────────────────────────────────────────────────────────

/**
 * Directories whose contents are themselves auto-generated and may
 * legitimately contain the watched literals, or source-faithful
 * evidence whose literal excerpts must never be rewritten.
 * `docs/snippets/constants/` is the snippet target.
 * `docs/decision-evidence/` preserves historical source and review
 * text verbatim. `docs/modules/` is the typedoc dump
 * (`pnpm docs:generate` re-renders it from JSDoc + source).
 *
 * Each entry is matched as a path prefix relative to `workspaceRoot`.
 */
const ALLOW_PREFIXES: readonly string[] = [
  "docs/decision-evidence/",
  "docs/snippets/constants/",
  "docs/modules/",
];

/**
 * Individual files that are generated as a whole. Same semantics as
 * `ALLOW_PREFIXES` but at the file granularity.
 */
const ALLOW_FILES: readonly string[] = [];

const isAllowed = (relPath: string): boolean =>
  ALLOW_FILES.includes(relPath) ||
  ALLOW_PREFIXES.some((p) => relPath.startsWith(p));

// ─── Per-file bake-marker exemption ───────────────────────────────────────
//
// Files that carry `{/* @bake-constants: NAME1 NAME2 ... */}` opt into
// generator-bake of the listed constants (see
// `scripts/docs/generate-constants-snippets.ts`). The literal value lives in
// the file by design — the bake step is the source of truth, and
// `pnpm docs:check:drift` catches drift via `git diff --exit-code` after
// regeneration. The gate's per-rule scan SKIPS rules whose constant name
// is listed in this file's marker; unlisted constants still flag.
const BAKE_MARKER_RE = /\{\/\*\s*@bake-constants:\s*([A-Z0-9_\s]+?)\s*\*\/\}/;

const readBakedConstants = (text: string): ReadonlySet<string> => {
  const m = BAKE_MARKER_RE.exec(text);
  if (m === null) return new Set();
  const names = (m[1] ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(names);
};

// ─── Read source of truth ─────────────────────────────────────────────────

interface ConstantRecord {
  readonly name: string;
  readonly value: string | number;
  readonly kind: "string" | "number";
  readonly sourcePath: string;
}

const loadConstants = (): readonly ConstantRecord[] => {
  const raw = readFileSync(valuesJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { constants?: ConstantRecord[] };
  if (!parsed.constants || !Array.isArray(parsed.constants)) {
    console.error(
      `check-no-hardcoded-constants: ${valuesJsonPath} is malformed (missing 'constants' array). Run \`pnpm docs:generate\` first.`,
    );
    process.exit(1);
  }
  return parsed.constants;
};

// ─── Doc walker ───────────────────────────────────────────────────────────

const isDocFile = (path: string): boolean =>
  path.endsWith(".md") || path.endsWith(".mdx");

const walkDocs = (root: string): string[] => {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = resolve(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        visit(abs);
      } else if (isDocFile(abs)) {
        out.push(abs);
      }
    }
  };
  visit(root);
  return out;
};

// ─── Rule definitions ─────────────────────────────────────────────────────

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly rule: string;
  readonly hint: string;
}

interface Rule {
  readonly name: string;
  readonly regex: RegExp;
  readonly hint: string;
  /** Pre-check that filters out false positives before matching. */
  readonly skipLine?: (line: string) => boolean;
}

const buildRules = (constants: readonly ConstantRecord[]): readonly Rule[] => {
  const byName = new Map(constants.map((c) => [c.name, c]));
  const escape = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules: Rule[] = [];

  const v2ProtocolVersion = byName.get("V2_PROTOCOL_VERSION");
  if (v2ProtocolVersion && v2ProtocolVersion.kind === "string") {
    rules.push({
      name: "V2_PROTOCOL_VERSION",
      regex: new RegExp(escape(v2ProtocolVersion.value as string)),
      hint: "Mark the file with `{/* @bake-constants: V2_PROTOCOL_VERSION */}` so the compatibility value is baked from `packages/identity/src/version.ts`.",
    });
  }

  // Catch-all: any version-shaped literal in docs. Drops false positives
  // that look like sizes or non-versions by requiring at least two dots
  // in the YYYY.MDD.patch shape. The skip is intentionally narrow: a
  // line containing ONLY the literal placeholder `YYYY.MDD.patch` (no
  // accompanying version-shaped literal) is exempt. If a line has BOTH
  // the placeholder and a real version literal, we still flag — the
  // common drift pattern is "here's `YYYY.MDD.patch` for now, like
  // `2026.524.1`", which silently bakes the real version in.
  rules.push({
    name: "VERSION_SHAPED_LITERAL",
    regex: /\b\d{4}\.\d{3,4}\.\d+\b/,
    hint: `Mark compatibility values with \`{/* @bake-constants: V2_PROTOCOL_VERSION */}\` so \`scripts/docs/generate-constants-snippets.ts\` keeps them in sync. For non-version examples, use the placeholder string \`YYYY.MDD.patch\` on its own.`,
    skipLine: (line) =>
      line.includes("YYYY.MDD.patch") &&
      !/\b\d{4}\.\d{3,4}\.\d+\b/.test(line.replace(/YYYY\.MDD\.patch/g, "")),
  });

  return rules;
};

// ─── Scan ────────────────────────────────────────────────────────────────

const scanFile = (
  absPath: string,
  rules: readonly Rule[],
  constants: readonly ConstantRecord[],
): readonly Violation[] => {
  const relPath = relative(workspaceRoot, absPath);
  if (isAllowed(relPath)) return [];
  const text = readFileSync(absPath, "utf8");
  const bakedConstants = readBakedConstants(text);
  const bakedVersionValues = new Set(
    constants
      .filter(
        (constant) =>
          constant.kind === "string" &&
          constant.name === "V2_PROTOCOL_VERSION" &&
          bakedConstants.has(constant.name),
      )
      .map((constant) => constant.value as string),
  );
  const lines = text.split("\n");
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const rule of rules) {
      if (bakedConstants.has(rule.name)) continue;
      let checkedLine = line;
      if (rule.name === "VERSION_SHAPED_LITERAL") {
        checkedLine = checkedLine.replace(
          /\b\d{4}\.\d{3,4}\.\d+\b/g,
          (token) => (bakedVersionValues.has(token) ? "" : token),
        );
      }
      if (rule.skipLine && rule.skipLine(checkedLine)) continue;
      if (rule.regex.test(checkedLine)) {
        violations.push({
          file: relPath,
          line: i + 1,
          text: line.trim(),
          rule: rule.name,
          hint: rule.hint,
        });
      }
    }
  }
  return violations;
};

// ─── Entry point ──────────────────────────────────────────────────────────

const main = (): void => {
  const constants = loadConstants();
  const rules = buildRules(constants);
  const docFiles = walkDocs(docsDir);
  const readmePath = resolve(workspaceRoot, "README.md");
  const targets = [...docFiles, readmePath];

  const violations: Violation[] = [];
  for (const f of targets) {
    violations.push(...scanFile(f, rules, constants));
  }

  if (violations.length === 0) {
    console.log(
      `[check-no-hardcoded-constants] OK — ${targets.length} files scanned, no hardcoded constants outside the allowlist.`,
    );
    process.exit(0);
  }

  console.error(
    `[check-no-hardcoded-constants] FAIL — ${violations.length} violation(s):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]`);
    console.error(`    ${v.text}`);
    console.error(`    → ${v.hint}\n`);
  }
  process.exit(1);
};

main();
