/**
 * @file Pure helpers extracted from `generate-cli-docs.ts` so parsing and
 * rendering behavior can be unit-tested without invoking the full generator
 * (which writes files and shells out to the built CLI binary).
 *
 * Source readers use TypeScript's syntax tree rather than regex over source.
 * Tests in `src/__tests__/scripts/generate-cli-docs.test.ts` pin the pure
 * behavior with fixtures.
 */
import ts from "typescript";

/** Typed result from a source-document reader. */
export type ReadResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly reason: string };

/**
 * Escape MDX-significant characters in CLI help prose while preserving code.
 * Help text is authored as terminal output, so placeholders such as `&lt;name>`
 * must become text before the same description can be embedded in MDX.
 * @param text Terminal help prose to escape for MDX.
 * @returns MDX-safe prose with code spans and fences preserved.
 */
export const escapeMdxProse = (text: string): string => {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        return line;
      }
      if (inFence || /^ {4,}/.test(line)) {
        return line;
      }
      return line
        .split(/(`[^`]*`)/)
        .map((segment, index) =>
          index % 2 === 1
            ? segment
            : segment
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll("{", "&#123;")
                .replaceAll("}", "&#125;"),
        )
        .join("");
    })
    .join("\n");
};

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
