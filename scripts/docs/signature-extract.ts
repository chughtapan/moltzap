/** @file Source signature scanning preserves nested types, comments, and string literals. */
import { ReflectionKind } from "./typedoc-load.ts";

const FUNCTION_KINDS = new Set<number>([
  ReflectionKind.Function,
  ReflectionKind.Method,
  ReflectionKind.Variable,
]);

const KEEP_BODY_KINDS = new Set<number>([
  ReflectionKind.Class,
  ReflectionKind.Interface,
  ReflectionKind.TypeAlias,
  ReflectionKind.Enum,
]);

interface ScanState {
  mode: "code" | "line" | "block" | "'" | '"' | "`";
}

/**
 * Extract the source text of an export declaration starting at the
 * given 1-based line number. For Function / Method / Variable the cut
 * is at the body's `=>` or `{`. A TypeAlias runs through its top-level
 * semicolon so a multiline union keeps every member. For Class /
 * Interface / Enum the cut keeps the full balanced body. Returns null
 * when the file is empty or the line is out of range.
 */
export function extractSignatureText(
  source: string,
  oneBasedLine: number,
  kind: number,
): string | null {
  if (source.length === 0) {
    return null;
  }
  const lines = source.split("\n");
  if (oneBasedLine < 1 || oneBasedLine > lines.length) {
    return null;
  }
  const startIx = skipLeadingJsDoc(lines, oneBasedLine - 1);
  if (kind === ReflectionKind.TypeAlias) {
    return extractTypeAlias(lines, startIx);
  }
  if (KEEP_BODY_KINDS.has(kind)) {
    return kind === ReflectionKind.Interface
      ? extractBalancedBody(lines, startIx)
      : extractBalancedBody(lines, startIx, 120);
  }
  if (FUNCTION_KINDS.has(kind)) {
    return extractFunctionSignature(lines, startIx);
  }
  return extractBalancedBody(lines, startIx, 120);
}

/**
 * TypeDoc reports the source line of the leading JSDoc block as the
 * declaration's source. Skip past the closing `*​/` so signature
 * extraction starts at the actual code.
 */
function skipLeadingJsDoc(lines: readonly string[], startIx: number): number {
  const first = lines[startIx]?.trimStart() ?? "";
  if (!first.startsWith("/**")) {
    return startIx;
  }
  for (let i = startIx; i < Math.min(lines.length, startIx + 200); i++) {
    if ((lines[i] ?? "").includes("*/")) {
      return skipBlankLines(lines, i + 1);
    }
  }
  return startIx;
}

function extractFunctionSignature(
  lines: readonly string[],
  startIx: number,
): string {
  const collected: string[] = [];
  for (let i = startIx; i < lines.length && i < startIx + 60; i++) {
    collected.push(lines[i] ?? "");
  }
  const joined = collected.join("\n");
  const cut = pickFirstCut(joined, ["=>", "{", ";"]);
  if (cut >= 0) {
    return joined.slice(0, cut).trimEnd();
  }
  return joined.trimEnd();
}

/**
 * Retains a complete type alias through its top-level semicolon.
 *
 * Multiline unions and intersections can return to zero bracket depth between
 * members, so a newline is not a declaration boundary for this syntax.
 *
 */
function extractTypeAlias(lines: readonly string[], startIx: number): string {
  const slice = lines.slice(startIx, Math.min(lines.length, startIx + 120));
  const text = slice.join("\n");
  let depth = 0;
  let semiIx = -1;
  scanTopLevel(text, (ch, i) => {
    if (["(", "[", "<", "{"].includes(ch)) {
      depth++;
    } else if ([")", "]", ">", "}"].includes(ch)) {
      depth--;
    } else if (ch === ";" && depth <= 0) {
      semiIx = i;
      return "stop";
    }
    return "continue";
  });
  return semiIx >= 0 ? text.slice(0, semiIx + 1).trimEnd() : text.trimEnd();
}

/**
 * Accumulate lines from `startIx` until the running token depth
 * (parens, brackets, angles, braces) returns to zero after at least
 * one opening token, checked at line boundaries so a single-line
 * declaration like `class X extends Y()&lt;...&gt;() {}` whose depth dips
 * through zero mid-line stays intact. A declaration with no opening
 * token at all (e.g. `export type Foo = Bar;`) ends at its own top-level
 * `;`; without that cut the scan runs on until some *later* declaration
 * opens a bracket, swallowing everything in between.
 *
 * Tokenization (string/line-comment/block-comment skipping plus the
 * `=>`/`&lt;=`/`&gt;=`/`==`/`!=` digraph carve-out) is shared with
 * `pickFirstCut` via `scanTopLevel`. The carve-out runs BEFORE the
 * callback so a `>=` in a class body like `if (this.n >= 1)` does
 * not decrement depth on the `>`; without it the body truncates at
 * the comparison.
 * Rendered as complete public signatures.
 */
function extractBalancedBody(
  lines: readonly string[],
  startIx: number,
  maxLines?: number,
): string {
  const slice = lines.slice(
    startIx,
    maxLines === undefined
      ? lines.length
      : Math.min(lines.length, startIx + maxLines),
  );
  const text = slice.join("\n");
  let depth = 0;
  let opened = false;
  let returnIx = -1;
  let semiIx = -1;
  scanTopLevel(text, (ch, i) => {
    if (["(", "[", "<", "{"].includes(ch)) {
      depth++;
      opened = true;
    } else if ([")", "]", ">", "}"].includes(ch)) {
      depth--;
    } else if (ch === ";" && !opened) {
      semiIx = i;
      return "stop";
    } else if (ch === "\n" && opened && depth <= 0) {
      returnIx = i;
      return "stop";
    }
    return "continue";
  });
  if (semiIx >= 0) {
    return text.slice(0, semiIx + 1).trimEnd();
  }
  if (returnIx >= 0) {
    return text.slice(0, returnIx).trimEnd();
  }
  return text.trimEnd();
}

/**
 * Find the first occurrence of any `needle` at TOP-LEVEL token depth
 * (outside strings, comments, AND outside paren / bracket / angle /
 * brace nesting). The depth gate keeps the function-signature cutter
 * from slicing inside an inline param-object type like
 * `connectTestClient(opts: ...)` whose first opening brace belongs to
 * the params, not the body opener; a depth-blind cut truncates the
 * signature inside the parameter object.
 *
 * Tokenization (string/comment/digraph skipping) is shared with
 * `extractBalancedBody` via `scanTopLevel`. Comment skipping is
 * required because inline JSDoc on a param-object member commonly
 * contains HTML-encoded open-angle paired with a literal close-angle
 * (the Mintlify generator escapes the open angle to keep markdown-in-
 * MDX happy). A naive depth tracker would decrement the angle counter
 * into a negative state on the lone close-angle and lose the top-
 * level detection that triggers the body-opener cut.
 */
function pickFirstCut(text: string, needles: readonly string[]): number {
  const depths = [0, 0, 0, 0];
  return scanTopLevel(text, (ch, i) => {
    if (
      depths.every((depth) => depth === 0) &&
      needles.some((needle) => text.startsWith(needle, i))
    ) {
      return "stop";
    }
    const index = "()[]<>{}".indexOf(ch);
    if (index >= 0) {
      const slot = Math.floor(index / 2);
      depths[slot] = (depths[slot] ?? 0) + (index % 2 === 0 ? 1 : -1);
    }
    return "continue";
  });
}

/**
 * Walk `text` invoking `cb(ch, ix)` for each character at syntactic
 * top level — outside string literals, line comments, and block
 * comments. The `&gt;=`, `&lt;=`, `==`, and `!=` digraphs are skipped
 * BEFORE `cb` runs so depth-tracking callbacks never see the `&gt;`
 * or `&lt;` as a generic-close/open. The `=&gt;` digraph stays AFTER
 * `cb` because `pickFirstCut` needs to stop on it as a needle
 * starting at `=`; the trailing `&gt;` is then skipped so it does
 * not decrement angle depth.
 *
 * Returns the index where the callback returned "stop", or -1 on
 * exhaustion.
 */
function scanTopLevel(
  text: string,
  cb: (ch: string, ix: number) => "stop" | "continue",
): number {
  const state: ScanState = { mode: "code" };
  let i = 0;
  while (i < text.length) {
    const skipped = skipLexeme(text, i, state);
    const next = skipped === null ? nextCodePosition(text, i, cb) : skipped + 1;
    if (next === -1) {
      return i;
    }
    i = next;
  }
  return -1;
}

function nextCodePosition(
  text: string,
  i: number,
  cb: (ch: string, ix: number) => "stop" | "continue",
): number {
  if ([">=", "<=", "!=", "=="].includes(text.slice(i, i + 2))) {
    return i + 2;
  }
  if (cb(text[i] ?? "", i) === "stop") {
    return -1;
  }
  return i + (text.startsWith("=>", i) ? 2 : 1);
}

function skipLexeme(text: string, i: number, state: ScanState): number | null {
  const ch = text[i];
  if (state.mode === "code") {
    return openLexeme(text, i, state);
  }
  if (state.mode === "line") {
    if (ch === "\n") {
      state.mode = "code";
    }
    return i;
  }
  if (state.mode === "block") {
    if (text.startsWith("*/", i)) {
      state.mode = "code";
      return i + 1;
    }
    return i;
  }
  return skipString(text, i, state);
}

function openLexeme(text: string, i: number, state: ScanState): number | null {
  const ch = text[i];
  if (ch === "'" || ch === '"' || ch === "`") {
    state.mode = ch;
    return i;
  }
  if (text.startsWith("//", i)) {
    state.mode = "line";
    return i + 1;
  }
  if (text.startsWith("/*", i)) {
    state.mode = "block";
    return i + 1;
  }
  return null;
}

function skipString(text: string, i: number, state: ScanState): number {
  if (text[i] === "\\") {
    return i + 1;
  }
  if (text[i] === state.mode) {
    state.mode = "code";
  }
  return i;
}

function skipBlankLines(lines: readonly string[], start: number): number {
  let i = start;
  while (i < lines.length && (lines[i] ?? "").trim().length === 0) {
    i++;
  }
  return i;
}
