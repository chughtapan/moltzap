/**
 * @file Pure AST helpers extracted from `generate-cli-docs.ts` so the
 * parser logic can be unit-tested without invoking the full generator
 * (which writes files and shells out to the built CLI binary).
 *
 * Doctrine: the AST is the contract. These helpers never use regex
 * over the source; every read flows through `typescript`'s syntax
 * tree. Tests in `src/__tests__/scripts/generate-cli-docs.test.ts`
 * pin the behavior with fixtures, including the idempotence property.
 */
import ts from "typescript";

export type ReadResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly reason: string };

/**
 * Walk an object-literal-heavy source file and collect numeric-literal
 * property assignments whose name is in `wanted`. Repeated names are
 * overwritten in source order; the last assignment wins.
 */
export const collectNumericProperties = (
  source: string,
  wanted: ReadonlySet<string>,
): Record<string, number> => {
  const src = ts.createSourceFile(
    "fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const out: Record<string, number> = {};
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const key = node.name.text;
      if (wanted.has(key) && ts.isNumericLiteral(node.initializer)) {
        out[key] = Number(node.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
};

/**
 * Find a top-level `export const NAME = "..."` (or unexported `const`)
 * declaration whose initializer is a string literal. Returns the
 * extracted string or a typed error if absent.
 */
export const readTopLevelStringConst = (
  source: string,
  identifier: string,
): ReadResult<string> => {
  const src = ts.createSourceFile(
    "fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const stmt of src.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === identifier &&
        decl.initializer !== undefined &&
        ts.isStringLiteral(decl.initializer)
      ) {
        return { _tag: "ok", value: decl.initializer.text };
      }
    }
  }
  return {
    _tag: "err",
    reason: `identifier '${identifier}' not found as a top-level string const`,
  };
};
