/**
 * @file Move a module docblock back above the imports it was stranded in.
 *
 * An import sorter sees a leading `/** ... *\/` block as trivia belonging to
 * the import it precedes, so reordering imports can carry the module's own
 * docblock down between them. Only a block lying strictly BETWEEN the first
 * and last import is stranded — one after the last import documents the
 * declaration below it and is left alone.
 *
 * Usage: node scripts/codemods/hoist-module-docblock.mjs [--write] [file...]
 */
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const explicit = argv.filter((a) => !a.startsWith("--"));

const files = explicit.length
  ? explicit
  : execSync(
      "find packages -name '*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*'",
    )
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);

let moved = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const imports = sf.statements.filter((s) => ts.isImportDeclaration(s));
  if (imports.length < 2) continue;

  const firstImportStart = imports[0].getStart(sf);
  const lastImportStart = imports[imports.length - 1].getStart(sf);

  let block = null;
  for (const stmt of imports) {
    const ranges = ts.getLeadingCommentRanges(src, stmt.getFullStart()) ?? [];
    const hit = ranges.find(
      (r) =>
        r.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
        src.slice(r.pos, r.pos + 3) === "/**" &&
        r.pos > firstImportStart &&
        r.pos < lastImportStart,
    );
    if (hit) {
      block = hit;
      break;
    }
  }
  if (!block) continue;

  // Land below a shebang and below any file-leading line comments (an
  // `eslint-disable` header), otherwise at position 0.
  let head = src.startsWith("#!") ? src.indexOf("\n") + 1 : 0;
  for (const r of ts.getLeadingCommentRanges(src, head) ?? []) {
    if (r.kind !== ts.SyntaxKind.SingleLineCommentTrivia) break;
    head = r.end + 1;
  }

  const text = src.slice(block.pos, block.end);
  let rest = src.slice(0, block.pos) + src.slice(block.end);
  rest = rest.slice(0, head) + rest.slice(head).replace(/^\s*\n/, "");
  const out =
    rest.slice(0, head) + (head ? "\n" : "") + text + "\n\n" + rest.slice(head);

  moved++;
  if (write) writeFileSync(file, out);
}
console.log(`${write ? "moved" : "would move"}: ${moved} module docblocks`);
