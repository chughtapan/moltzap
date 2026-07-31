/**
 * Step 2 of the file-organization migration: move declarations into their
 * canonical band and order the implementation band by first call.
 *
 * Bands, top-down:
 *   2 imports | 3 declarations (types, SCREAMING_CASE constants, error classes)
 *   4 primary exports | 5 implementation (non-exported)
 *
 * Only two kinds move: types (erased at runtime) and function declarations
 * (hoisted). `const` and `class` carry initialization order, so a file whose
 * value statements would change relative order is reported, not rewritten.
 *
 * Usage: node scripts/codemods/reorder-bands.mjs [--write] [--stepdown] [path...]
 */
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const stepdown = argv.includes("--stepdown");
const roots = argv.filter((a) => !a.startsWith("--"));
const scope = roots.length ? roots.join(" ") : "packages v2";

const SCREAMING = /^[A-Z][A-Z0-9_]*$/;
const ERROR_BASE =
  /TaggedError|TaggedClass|Data\.Error|Data\.Class|Schema\.TaggedError/;

function bandOf(stmt, sf) {
  if (ts.isImportDeclaration(stmt)) return 2;
  const exported = stmt.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt))
    return 3;
  if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations[0];
    if (d && ts.isIdentifier(d.name) && SCREAMING.test(d.name.text)) return 3;
    return exported ? 4 : 5;
  }
  if (ts.isClassDeclaration(stmt)) {
    const heritage =
      stmt.heritageClauses?.map((h) => h.getText(sf)).join(" ") ?? "";
    if (ERROR_BASE.test(heritage)) return 3;
    return exported ? 4 : 5;
  }
  if (ts.isFunctionDeclaration(stmt)) return exported ? 4 : 5;
  // `export { ... }` / `export * from ...` — position-independent re-exports
  if (ts.isExportDeclaration(stmt)) return 4;
  return null;
}

const isValueStatement = (s) =>
  ts.isVariableStatement(s) || ts.isClassDeclaration(s);

/**
 * Source range including the statement's attached leading comments, plus
 * whether a blank line preceded it. Packed runs (three related regexes, a
 * block of one-line constants) stay packed after the move; forcing a blank
 * line between every statement would destroy that grouping.
 */
function moveRange(stmt, src, sf) {
  const leading = ts.getLeadingCommentRanges(src, stmt.getFullStart()) ?? [];
  const start = leading.length ? leading[0].pos : stmt.getStart(sf);
  // trivia between the previous statement's end and this one's first token
  const gap = src.slice(stmt.getFullStart(), start);
  return { start, end: stmt.getEnd(), blankBefore: /\n[ \t]*\n/.test(gap) };
}

function declaredName(stmt) {
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt))
    return stmt.name?.text;
  if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations[0];
    return d && ts.isIdentifier(d.name) ? d.name.text : undefined;
  }
  return undefined;
}

function referencesName(stmt, name, sf) {
  let hit = false;
  const walk = (n) => {
    if (hit) return;
    if (ts.isIdentifier(n) && n.text === name && n.parent !== stmt) hit = true;
    else n.forEachChild(walk);
  };
  stmt.forEachChild(walk);
  return hit;
}

/** Order band-5 entries so each sits below the first statement that calls it. */
function stepdownOrder(placed, pool, sf) {
  const out = [...placed];
  const rest = [...pool];
  while (rest.length) {
    let best = 0;
    let bestScore = Infinity;
    rest.forEach((cand, i) => {
      const name = declaredName(cand);
      if (!name) return;
      const idx = out.findIndex((s) => referencesName(s, name, sf));
      const score = idx === -1 ? Infinity : idx;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    out.push(rest.splice(best, 1)[0]);
  }
  return out.slice(placed.length);
}

const files = execSync(
  `find ${scope} -name '*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*'`,
)
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter(
    (f) =>
      !/\.(test|spec|types-check)\.ts$/.test(f) &&
      !f.includes("/test-utils/") &&
      !f.includes("/testing/") &&
      !f.includes("/__tests__/"),
  );

let rewritten = 0,
  skipped = 0,
  alreadyOk = 0,
  moves = 0;
const skips = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const stmts = [...sf.statements];
  if (stmts.length < 5) continue;
  if (stmts.some((s) => bandOf(s, sf) === null)) {
    skipped++;
    skips.push(`${file} (unclassified top-level statement)`);
    continue;
  }

  const bands = new Map(stmts.map((s) => [s, bandOf(s, sf)]));
  let monotonic = true,
    max = 0;
  for (const s of stmts) {
    if (bands.get(s) < max) {
      monotonic = false;
      break;
    }
    max = bands.get(s);
  }
  if (monotonic) {
    alreadyOk++;
    continue;
  }

  // stable partition by band
  let target = [2, 3, 4, 5].flatMap((b) =>
    stmts.filter((s) => bands.get(s) === b),
  );

  if (stepdown) {
    const head = target.filter((s) => bands.get(s) !== 5);
    const tail = target.filter((s) => bands.get(s) === 5);
    target = [...head, ...stepdownOrder(head, tail, sf)];
  }

  // safety: value statements must keep their relative order
  const before = stmts.filter(isValueStatement);
  const after = target.filter(isValueStatement);
  if (before.some((s, i) => s !== after[i])) {
    skipped++;
    skips.push(file);
    continue;
  }

  const changed = stmts.some((s, i) => s !== target[i]);
  if (!changed) {
    alreadyOk++;
    continue;
  }
  moves += stmts.reduce((n, s, i) => n + (s !== target[i] ? 1 : 0), 0);
  rewritten++;
  if (!write) continue;

  const ranges = new Map(stmts.map((s) => [s, moveRange(s, src, sf)]));

  // A leading `@file` block documents the module, not the statement it happens
  // to precede. Pin it above the reordered body so hoisted imports cannot
  // displace it (jsdoc/require-file-overview enforces this).
  const headLeading =
    ts.getLeadingCommentRanges(src, stmts[0].getFullStart()) ?? [];
  const filedoc = headLeading.find((c) =>
    /@(file|fileoverview)\b/.test(src.slice(c.pos, c.end)),
  );
  if (filedoc) {
    const r = ranges.get(stmts[0]);
    if (r.start <= filedoc.pos)
      ranges.set(stmts[0], { ...r, start: filedoc.end + 1 });
  }

  const first = filedoc ? filedoc.end + 1 : ranges.get(stmts[0]).start;
  const last = ranges.get(stmts[stmts.length - 1]).end;
  const body = target
    .map((s, i) => {
      const r = ranges.get(s);
      const text = src.slice(r.start, r.end);
      if (i === 0) return text;
      return (r.blankBefore ? "\n\n" : "\n") + text;
    })
    .join("");
  writeFileSync(file, src.slice(0, first) + body + src.slice(last));
}

console.log(
  `${write ? "rewrote" : "would rewrite"}: ${rewritten} files (${moves} statements moved)`,
);
console.log(`already conforming: ${alreadyOk}`);
console.log(`skipped (value-statement order would change): ${skipped}`);
skips.slice(0, 12).forEach((s) => console.log(`  ${s}`));
