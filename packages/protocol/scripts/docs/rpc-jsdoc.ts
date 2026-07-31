/**
 * @file Scan protocol source files for `defineRpc({...})` and
 * `defineNotification({...})` call sites, paired with the JSDoc on
 * their enclosing `export const Foo = ...` declaration. Output is a
 * `Map&lt;wireName, RpcJsDoc>` indexed by the literal `name:` property
 * inside the call.
 *
 * Replaces the hand-maintained prose map in
 * `scripts/docs/metadata.ts` once every `defineRpc` call site carries
 * its own JSDoc.
 */
import { FileSystem, Path } from "@effect/platform";
import { Effect, String as StringOps } from "effect";
import * as ts from "typescript";

/** Describes rpc error tag. */
export interface RpcErrorTag {
  readonly name: string; // tagged-error class name; code resolves via registry
  readonly when: string;
}

/** Describes rpc js doc. */
export interface RpcJsDoc {
  readonly description: string | null;
  readonly body: string | null; // free-form prose after the description
  readonly resultDescription: string | null; // @returns
  readonly errors: readonly RpcErrorTag[];
  readonly relatedNotifications: readonly string[];
  readonly triggeredBy: readonly string[];
  readonly tsName: string;
  readonly file: string; // workspace-relative
  readonly line: number;
}

const DEFINER_NAMES = new Set(["defineRpc", "defineNotification"]);

/**
 * Walk the given source files, parse each into a TypeScript AST,
 * locate `export const Foo = defineRpc({ name: "x/y", ... })` (and
 * the analogous `defineNotification` form), and return a lookup
 * from the wire name (`"x/y"`) to the parsed JSDoc block.
 *
 * Workspace-relative file paths are recorded so consumers can render
 * `file:line` source links.
 * @param workspaceRoot Value supplied to the operation.
 * @param sourceFiles Value supplied to the operation.
 * @returns The collect from source result.
 */
export const collectRpcJsDoc = (
  workspaceRoot: string,
  sourceFiles: readonly string[],
): Effect.Effect<
  ReadonlyMap<string, RpcJsDoc>,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const out = new Map<string, RpcJsDoc>();
    for (const file of sourceFiles) {
      const absolute = path.resolve(workspaceRoot, file);
      const source = yield* fs
        .readFileString(absolute)
        .pipe(Effect.catchAll(() => Effect.succeed("")));
      if (source.length === 0) {
        continue;
      }
      collectFromSource(file, source, out);
    }
    return out;
  });

function collectFromSource(
  relativeFile: string,
  source: string,
  out: Map<string, RpcJsDoc>,
): void {
  const sf = ts.createSourceFile(
    relativeFile,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) {
      continue;
    }
    if (!hasExportModifier(stmt)) {
      continue;
    }
    const decl = stmt.declarationList.declarations[0];
    if (!decl || !decl.initializer || !ts.isIdentifier(decl.name)) {
      continue;
    }
    if (!isDefinerCall(decl.initializer)) {
      continue;
    }
    const wireName = extractWireName(decl.initializer);
    if (wireName === null) {
      continue;
    }
    const tsName = decl.name.text;
    const jsdoc = parseJsDocBlock(stmt, sf);
    const pos = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
    out.set(wireName, {
      ...jsdoc,
      tsName,
      file: relativeFile,
      line: pos.line + 1,
    });
  }
}

function hasExportModifier(stmt: ts.VariableStatement): boolean {
  const mods = stmt.modifiers ?? [];
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isDefinerCall(node: ts.Expression): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  if (!ts.isIdentifier(node.expression)) {
    return false;
  }
  return DEFINER_NAMES.has(node.expression.text);
}

function extractWireName(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return null;
  }
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      continue;
    }
    if (!ts.isIdentifier(prop.name)) {
      continue;
    }
    if (prop.name.text !== "name") {
      continue;
    }
    if (!ts.isStringLiteral(prop.initializer)) {
      continue;
    }
    return prop.initializer.text;
  }
  return null;
}

interface ParsedJsDoc {
  readonly description: string | null;
  readonly body: string | null;
  readonly resultDescription: string | null;
  readonly errors: readonly RpcErrorTag[];
  readonly relatedNotifications: readonly string[];
  readonly triggeredBy: readonly string[];
}

function parseJsDocBlock(
  stmt: ts.VariableStatement,
  sf: ts.SourceFile,
): ParsedJsDoc {
  const ranges = ts.getLeadingCommentRanges(
    sf.getFullText(),
    stmt.getFullStart(),
  );
  if (!ranges) {
    return emptyJsDoc();
  }
  for (const range of ranges) {
    if (range.kind !== ts.SyntaxKind.MultiLineCommentTrivia) {
      continue;
    }
    const text = sf.getFullText().slice(range.pos, range.end);
    if (!StringOps.startsWith("/**")(text)) {
      continue;
    }
    return parseJsDocText(text);
  }
  return emptyJsDoc();
}

function emptyJsDoc(): ParsedJsDoc {
  return {
    description: null,
    body: null,
    resultDescription: null,
    errors: [],
    relatedNotifications: [],
    triggeredBy: [],
  };
}

/**
 * Parse the raw `/** ... *​/` text of a JSDoc block into structured
 * tags. Strips the comment markup (leading `*`s, surrounding `/**`
 * and `*​/`), splits on lines starting with `@`, and slots known tags
 * (`@returns`, `@error`, `@relatedNotification`, `@triggeredBy`).
 *
 * Body prose (the description block before the first `@` line and
 * any prose between `@`-tagged lines that isn't itself a tag) flows
 * into the description / body fields.
 * @param text Text to process.
 * @returns The decoded js doc text.
 */
export function parseJsDocText(text: string): ParsedJsDoc {
  const body = stripJsDocMarkup(text);
  const sections = splitOnTagBoundary(body);
  let description: string | null = null;
  let bodyProse: string | null = null;
  let resultDescription: string | null = null;
  const errors: RpcErrorTag[] = [];
  const relatedNotifications: string[] = [];
  const triggeredBy: string[] = [];
  for (const section of sections) {
    if (!section.tag) {
      const parts = splitDescriptionAndBody(section.content);
      description = parts.description;
      bodyProse = parts.body;
      continue;
    }
    switch (section.tag) {
      case "@returns":
        resultDescription = section.content;
        break;
      case "@error": {
        const parsed = parseErrorTag(section.content);
        if (parsed !== null) {
          errors.push(parsed);
        }
        break;
      }
      case "@relatedNotification":
        relatedNotifications.push(section.content);
        break;
      case "@triggeredBy":
        triggeredBy.push(section.content);
        break;
      default:
        break;
    }
  }
  return {
    description,
    body: bodyProse,
    resultDescription,
    errors,
    relatedNotifications,
    triggeredBy,
  };
}

function stripJsDocMarkup(text: string): string {
  const withoutOpening = StringOps.replace(/^\/\*\*/, "")(text);
  const body = StringOps.replace(/\*\/$/, "")(withoutOpening);
  const lines = StringOps.split(body, "\n").map((line) =>
    StringOps.trimEnd(StringOps.replace(/^\s*\*\s?/, "")(line)),
  );
  return StringOps.trim(lines.join("\n"));
}

interface JsDocSection {
  readonly tag: string | null;
  readonly content: string;
}

function splitOnTagBoundary(body: string): readonly JsDocSection[] {
  const lines = StringOps.split(body, "\n");
  const sections: Array<{ tag: string | null; lines: string[] }> = [
    { tag: null, lines: [] },
  ];
  for (const line of lines) {
    const tagMatch = /^(@[a-zA-Z]+)(?: (.*))?$/.exec(line);
    if (tagMatch) {
      sections.push({ tag: tagMatch[1] ?? null, lines: [tagMatch[2] ?? ""] });
    } else {
      const current = sections.at(-1);
      if (current !== undefined) {
        current.lines.push(line);
      }
    }
  }
  return sections
    .map((s) => ({ tag: s.tag, content: s.lines.join("\n").trim() }))
    .filter((s) => s.tag !== null || s.content.length > 0);
}

function splitDescriptionAndBody(text: string): {
  readonly description: string | null;
  readonly body: string | null;
} {
  if (StringOps.isEmpty(text)) {
    return { description: null, body: null };
  }
  const blankBoundary = /\n\n/.exec(text);
  if (blankBoundary === null) {
    return { description: text, body: null };
  }
  const blankIx = blankBoundary.index;
  return {
    description: StringOps.trim(StringOps.slice(0, blankIx)(text)),
    body: StringOps.trim(StringOps.slice(blankIx + 2)(text)),
  };
}

/**
 * Parse the content of an `@error` tag. Expected shape:
 * `&lt;Name> when &lt;prose>` where `&lt;Name>` is the tagged-error class
 * (e.g. `ConflictError`, `ForbiddenError`) and `&lt;prose>` is
 * free-form. The wire code is resolved later from the protocol's
 * error registry. Returns null if the tag content doesn't parse.
 * @param text Text to process.
 * @returns The decoded error tag.
 */
export function parseErrorTag(text: string): RpcErrorTag | null {
  const t = StringOps.trim(text);
  const whenBoundary = / when /.exec(t);
  if (whenBoundary === null) {
    return null;
  }
  const whenIx = whenBoundary.index;
  const name = StringOps.trim(StringOps.slice(0, whenIx)(t));
  const when = StringOps.trim(StringOps.slice(whenIx + 6)(t));
  if (StringOps.isEmpty(name) || StringOps.isEmpty(when)) {
    return null;
  }
  if (/\s/.test(name)) {
    return null;
  } // type name has no spaces
  return { name, when };
}
