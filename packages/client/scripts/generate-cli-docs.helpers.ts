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

export type ReadResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly reason: string };

/**
 * Escape MDX-significant characters in CLI help prose while preserving code.
 * Help text is authored as terminal output, so placeholders such as `<name>`
 * must become text before the same description can be embedded in MDX.
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
      if (inFence || /^ {4,}/.test(line)) return line;
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

/** Read the canonical version string from a package.json document. */
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
