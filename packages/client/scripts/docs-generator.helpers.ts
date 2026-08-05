/**
 * @file Pure source readers shared by the docs generators, so parsing behavior
 * can be unit-tested without invoking a generator that writes files.
 *
 * Readers use TypeScript's syntax tree rather than regex over source. Tests in
 * `src/__tests__/scripts/docs-generator-helpers.test.ts` pin the pure behavior
 * with fixtures.
 */
import ts from "typescript";

/** Typed result from a source-document reader. */
export type ReadResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly reason: string };

/**
 * Read the canonical version string from a package.json document.
 * @param source Serialized package.json content.
 * @returns The version or a typed parse/shape failure.
 */
export const readPackageVersion = (source: string): ReadResult<string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    return {
      _tag: "err",
      reason: `invalid package.json: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string"
  ) {
    return { _tag: "err", reason: "package.json has no string version field" };
  }
  return { _tag: "ok", value: parsed.version };
};

/**
 * Find a top-level `export const NAME = "..."` (or unexported `const`)
 * declaration whose initializer is a string literal. Returns the
 * extracted string or a typed error if absent.
 * @param source TypeScript source text to inspect.
 * @param identifier Top-level constant name to find.
 * @returns The string initializer or a typed lookup failure.
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
  for (const statement of src.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const declaration = statement.declarationList.declarations.find(
      (candidate) =>
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === identifier &&
        candidate.initializer !== undefined &&
        ts.isStringLiteral(candidate.initializer),
    );
    if (
      declaration?.initializer !== undefined &&
      ts.isStringLiteral(declaration.initializer)
    ) {
      return { _tag: "ok", value: declaration.initializer.text };
    }
  }
  return {
    _tag: "err",
    reason: `identifier '${identifier}' not found as a top-level string const`,
  };
};
