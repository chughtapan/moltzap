/**
 * Step 1 of the file-organization migration: convert module-level, non-exported
 * `const f = (...) => ...` helpers into `function f(...)` declarations.
 *
 * Function declarations hoist; `const` arrows sit in the TDZ until evaluated.
 * Top-down file order requires helpers to live BELOW their callers, which is
 * only legal once they are hoisted.
 *
 * Edits are computed as text ranges and applied back-to-front so every offset
 * stays valid; nothing is re-printed, so comments and formatting survive.
 *
 * Usage: node scripts/codemods/arrow-to-function.mjs [--write] [path...]
 */
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const roots = argv.filter((a) => !a.startsWith("--"));
const scope = roots.length ? roots.join(" ") : "packages v2";

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

let converted = 0;
let skipped = 0;
const skips = [];
const touched = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const edits = [];

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      continue;
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    if (stmt.declarationList.declarations.length !== 1) continue;

    const decl = stmt.declarationList.declarations[0];
    if (!decl.initializer || !ts.isArrowFunction(decl.initializer)) continue;
    if (!ts.isIdentifier(decl.name)) continue;

    const arrow = decl.initializer;
    const name = decl.name.text;

    // An explicit annotation may be contextually typing the parameters; a
    // function declaration would lose that and silently widen to `any`.
    if (decl.type) {
      skipped++;
      skips.push(`${file} → ${name} (type annotation)`);
      continue;
    }
    // Arrows capture `this` lexically; a declaration would rebind it.
    if (/\bthis\b|\barguments\b/.test(arrow.getText(sf))) {
      skipped++;
      skips.push(`${file} → ${name} (references this/arguments)`);
      continue;
    }

    const isAsync = arrow.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
    );
    const sigStart = arrow.modifiers?.length
      ? arrow.modifiers[arrow.modifiers.length - 1].getEnd()
      : arrow.getStart(sf);
    const signature = src
      .slice(sigStart, arrow.equalsGreaterThanToken.getStart(sf))
      .trim();

    edits.push({
      start: stmt.getStart(sf),
      end: arrow.equalsGreaterThanToken.getEnd(),
      text: `${isAsync ? "async " : ""}function ${name}${signature} `,
    });

    if (ts.isBlock(arrow.body)) {
      // drop the variable statement's trailing `;`
      edits.push({ start: arrow.body.getEnd(), end: stmt.getEnd(), text: "" });
    } else {
      const expr = src.slice(arrow.body.getStart(sf), arrow.body.getEnd());
      edits.push({
        start: arrow.body.getStart(sf),
        end: stmt.getEnd(),
        text: `{\n  return ${expr};\n}`,
      });
    }
    converted++;
  }

  if (!edits.length) continue;
  touched.push(file);
  if (!write) continue;

  let out = src;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  writeFileSync(file, out);
}

console.log(
  `${write ? "converted" : "would convert"}: ${converted} across ${touched.length} files`,
);
console.log(`skipped: ${skipped}`);
skips.forEach((s) => console.log(`  ${s}`));
