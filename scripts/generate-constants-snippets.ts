#!/usr/bin/env tsx
/**
 * @file Source-of-truth generator for doc-embedded constants. Reads
 * the canonical literals out of TS source files via the TypeScript
 * compiler API (no regex over the source — the AST is the contract)
 * and the quickstart port out of `scripts/quickstart.sh`. Emits two
 * sibling files under `docs/snippets/constants/`:
 *
 *   - `values.json` — JSON record consumed by
 *     `scripts/check-no-hardcoded-constants.ts` (the drift gate).
 *   - `values.mdx`  — Mintlify-friendly MDX module exporting each
 *     constant as a JSX variable. Retained for the rare case where a
 *     constant is rendered in a context Mintlify evaluates (plain
 *     prose, not backticks / fenced code blocks).
 *
 * In addition this script BAKES literal values into every `.mdx`
 * (and `README.md`) file that carries a `@bake-constants: NAME ...`
 * marker comment. Bake-at-generation-time is the robust fix for MDX
 * not evaluating `{VAR}` JSX expressions inside backtick code spans
 * or fenced code blocks (Mintlify quirk). Drift is caught because
 * regenerating after a source-side change produces a literal diff in
 * the consumer file, which `pnpm docs:check:drift` git-diff-gates.
 *
 * Wired into `pnpm docs:generate`; `pnpm docs:check:drift` then catches
 * any drift between the snippets and the source-of-truth files.
 *
 * Adding a new constant: append an entry to `collect()`, point it
 * at the source file + identifier, and the generator + the gate pick
 * it up automatically.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "..");
const docsDir = resolve(workspaceRoot, "docs");
const constantsDir = resolve(docsDir, "snippets", "constants");

// ─── Typed result + reader primitives ─────────────────────────────────────

type ReadResult<T> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly reason: string };

const ok = <T>(value: T): ReadResult<T> => ({ _tag: "ok", value });
const err = (reason: string): ReadResult<never> => ({
  _tag: "err",
  reason,
});

const parseSource = (filePath: string): ts.SourceFile => {
  const text = readFileSync(filePath, "utf8");
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
};

const literalFromInitializer = (
  init: ts.Expression,
): string | number | null => {
  const inner = ts.isAsExpression(init) ? init.expression : init;
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return inner.text;
  }
  if (ts.isNumericLiteral(inner)) return Number(inner.text);
  if (ts.isCallExpression(inner) && inner.arguments.length === 1) {
    const arg = inner.arguments[0];
    if (arg !== undefined) return literalFromInitializer(arg);
  }
  return null;
};

/**
 * Find a top-level `const NAME = <Literal>` declaration whose initializer is a
 * string or numeric literal (optionally with a trailing `as <TypeReference>`),
 * or a one-argument constructor wrapping that literal, e.g.
 * `Schema.decodeSync(AppId)("...")`.
 */
const readTopLevelLiteral = (
  filePath: string,
  identifier: string,
): ReadResult<string | number> => {
  const src = parseSource(filePath);
  let found: string | number | null = null;
  for (const stmt of src.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== identifier)
        continue;
      const init = decl.initializer;
      if (init === undefined) continue;
      found = literalFromInitializer(init);
    }
  }
  return found === null
    ? err(
        `identifier '${identifier}' not found as a top-level literal in ${filePath}`,
      )
    : ok(found);
};

/**
 * Read the quickstart's preferred host port out of `scripts/quickstart.sh`.
 * Shell file → regex is the right tool; the source line is
 * `PORT="${MOLTZAP_PORT:-41973}"` and the gate treats this snippet as
 * the canonical home for the literal.
 */
const readQuickstartPort = (filePath: string): ReadResult<number> => {
  const text = readFileSync(filePath, "utf8");
  const m = text.match(/MOLTZAP_PORT:-(\d+)/);
  if (m === null || m[1] === undefined) {
    return err(
      `quickstart.sh: could not find MOLTZAP_PORT default in ${filePath}`,
    );
  }
  return ok(Number(m[1]));
};

// ─── Constant specs ───────────────────────────────────────────────────────

interface StringConstant {
  readonly kind: "string";
  readonly name: string;
  readonly value: string;
  readonly sourcePath: string;
  readonly note: string;
}

interface NumberConstant {
  readonly kind: "number";
  readonly name: string;
  readonly value: number;
  readonly sourcePath: string;
  readonly note: string;
}

type Constant = StringConstant | NumberConstant;

const collect = (): readonly Constant[] => {
  const protocolVersion = readTopLevelLiteral(
    resolve(workspaceRoot, "packages/protocol/src/network/connect.ts"),
    "PROTOCOL_VERSION",
  );
  const defaultAppId = readTopLevelLiteral(
    resolve(workspaceRoot, "packages/protocol/src/identity/apps/ids.ts"),
    "DEFAULT_APP_ID",
  );
  const defaultServerPort = readTopLevelLiteral(
    resolve(workspaceRoot, "packages/server/src/config.ts"),
    "DEFAULT_SERVER_PORT",
  );
  const apiKeyPrefix = readTopLevelLiteral(
    resolve(workspaceRoot, "packages/server/src/identity/credential-keys.ts"),
    "API_KEY_PREFIX",
  );
  const quickstartPort = readQuickstartPort(
    resolve(workspaceRoot, "scripts/quickstart.sh"),
  );

  const failures: string[] = [];
  const requireString = (
    name: string,
    sourcePath: string,
    res: ReadResult<string | number>,
    note: string,
  ): StringConstant | null => {
    if (res._tag === "err") {
      failures.push(`${name}: ${res.reason}`);
      return null;
    }
    if (typeof res.value !== "string") {
      failures.push(
        `${name}: expected string literal, got ${typeof res.value}`,
      );
      return null;
    }
    return { kind: "string", name, value: res.value, sourcePath, note };
  };
  const requireNumber = (
    name: string,
    sourcePath: string,
    res: ReadResult<string | number>,
    note: string,
  ): NumberConstant | null => {
    if (res._tag === "err") {
      failures.push(`${name}: ${res.reason}`);
      return null;
    }
    if (typeof res.value !== "number") {
      failures.push(
        `${name}: expected numeric literal, got ${typeof res.value}`,
      );
      return null;
    }
    return { kind: "number", name, value: res.value, sourcePath, note };
  };

  const constants: ReadonlyArray<Constant | null> = [
    requireString(
      "PROTOCOL_VERSION",
      "packages/protocol/src/network/connect.ts",
      protocolVersion,
      "Current wire-protocol version emitted in HelloOk + accepted in `network/connect`.",
    ),
    requireString(
      "DEFAULT_APP_ID",
      "packages/protocol/src/identity/apps/ids.ts",
      defaultAppId,
      "Built-in unmoderated default-app UUID. Conversations created without an explicit app bind here.",
    ),
    requireNumber(
      "DEFAULT_SERVER_PORT",
      "packages/server/src/config.ts",
      defaultServerPort,
      "Code-level fallback port used by ServerConfigLoader when PORT is unset.",
    ),
    requireString(
      "API_KEY_PREFIX",
      "packages/server/src/identity/credential-keys.ts",
      apiKeyPrefix,
      "Stable string prefix on every agent API key.",
    ),
    requireNumber(
      "QUICKSTART_PORT",
      "scripts/quickstart.sh",
      quickstartPort,
      "Port the quickstart.sh script binds the local server to (chosen to avoid 3000/3100 conflicts).",
    ),
  ];

  if (failures.length > 0) {
    const lines = [
      "generate-constants-snippets: failed to read source constants:",
      ...failures.map((f) => `  - ${f}`),
    ];
    console.error(lines.join("\n"));
    process.exit(1);
  }

  return constants.filter((c): c is Constant => c !== null);
};

// ─── Render ──────────────────────────────────────────────────────────────

const AUTO_GEN_NOTE =
  "{/* AUTO-GENERATED by scripts/generate-constants-snippets.ts. " +
  "Do not edit by hand — re-run `pnpm docs:generate`. */}";

const renderMdx = (constants: readonly Constant[]): string => {
  const lines: string[] = [AUTO_GEN_NOTE, ""];
  for (const c of constants) {
    lines.push(`{/* ${c.note} Source: ${c.sourcePath}. */}`);
    if (c.kind === "string") {
      lines.push(`export const ${c.name} = ${JSON.stringify(c.value)};`);
    } else {
      lines.push(`export const ${c.name} = ${c.value};`);
    }
    lines.push("");
  }
  return lines.join("\n");
};

interface JsonRecord {
  readonly generatedBy: string;
  readonly constants: readonly {
    readonly name: string;
    readonly value: string | number;
    readonly kind: "string" | "number";
    readonly sourcePath: string;
    readonly note: string;
  }[];
}

const renderJson = (constants: readonly Constant[]): string => {
  const record: JsonRecord = {
    generatedBy: "scripts/generate-constants-snippets.ts",
    constants: constants.map((c) => ({
      name: c.name,
      value: c.value,
      kind: c.kind,
      sourcePath: c.sourcePath,
      note: c.note,
    })),
  };
  return JSON.stringify(record, null, 2) + "\n";
};

// ─── Bake step ────────────────────────────────────────────────────────────
//
// Walks every `.mdx` doc (plus `README.md`) for the `@bake-constants:`
// marker, then replaces stale literal values with the freshly generated
// ones. The marker is the explicit opt-in (and the trust boundary for
// `check-no-hardcoded-constants.ts`); a file without the marker is
// untouched.

const BAKE_MARKER_RE = /\{\/\*\s*@bake-constants:\s*([A-Z0-9_\s]+?)\s*\*\/\}/;

const isDocFile = (p: string): boolean =>
  p.endsWith(".mdx") || p.endsWith(".md");

const walkDocFiles = (root: string): string[] => {
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

interface BakeRecord {
  readonly file: string;
  readonly constant: string;
  readonly previousValue: string | number;
  readonly newValue: string | number;
}

interface BakeFailure {
  readonly file: string;
  readonly constant: string;
  readonly reason: string;
}

interface BakeFileResult {
  readonly records: readonly BakeRecord[];
  readonly failures: readonly BakeFailure[];
}

const literalForReplace = (value: string | number): string =>
  typeof value === "string" ? value : String(value);

/**
 * Replace `previous` literal occurrences with `next` in the file body
 * (everywhere except the marker line and the constants snippet itself).
 * Numeric replacements use a digit-boundary guard so `3000` doesn't
 * smash `30000`; string replacements are taken verbatim — the literal
 * is the unique key. Returns the modified body + a per-occurrence
 * count.
 */
const replaceLiteral = (
  body: string,
  previous: string | number,
  next: string | number,
): { readonly body: string; readonly count: number } => {
  if (previous === next) return { body, count: 0 };
  const prevText = literalForReplace(previous);
  const nextText = literalForReplace(next);
  if (prevText.length === 0) return { body, count: 0 };
  let count = 0;
  let out = "";
  let cursor = 0;
  const numeric = typeof previous === "number";
  while (cursor < body.length) {
    const idx = body.indexOf(prevText, cursor);
    if (idx === -1) {
      out += body.slice(cursor);
      break;
    }
    out += body.slice(cursor, idx);
    if (numeric) {
      const before = idx > 0 ? body.charCodeAt(idx - 1) : 0;
      const afterPos = idx + prevText.length;
      const after = afterPos < body.length ? body.charCodeAt(afterPos) : 0;
      const isDigit = (c: number): boolean => c >= 48 && c <= 57;
      const isWord = (c: number): boolean =>
        isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
      if (isDigit(before) || isWord(after)) {
        out += prevText;
        cursor = afterPos;
        continue;
      }
    }
    out += nextText;
    count += 1;
    cursor = idx + prevText.length;
  }
  return { body: out, count };
};

const bakeFile = (
  absPath: string,
  constants: ReadonlyMap<string, Constant>,
  previousValues: ReadonlyMap<string, string | number>,
): BakeFileResult => {
  const original = readFileSync(absPath, "utf8");
  const m = BAKE_MARKER_RE.exec(original);
  if (m === null) return { records: [], failures: [] };
  const names = (m[1] ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) return { records: [], failures: [] };
  let body = original;
  const records: BakeRecord[] = [];
  const failures: BakeFailure[] = [];
  const fileLabel = relative(workspaceRoot, absPath);
  for (const name of names) {
    const c = constants.get(name);
    if (!c) {
      failures.push({
        file: fileLabel,
        constant: name,
        reason: "marker lists unknown constant",
      });
      continue;
    }
    const previous = previousValues.get(name);
    if (previous === undefined) continue;
    const next = c.value;
    const replacement = replaceLiteral(body, previous, next);
    if (replacement.count > 0) {
      body = replacement.body;
      records.push({
        file: fileLabel,
        constant: name,
        previousValue: previous,
        newValue: next,
      });
    }
  }
  if (body !== original) writeFileSync(absPath, body);
  return { records, failures };
};

const loadPreviousValues = (
  jsonPath: string,
): ReadonlyMap<string, string | number> => {
  const out = new Map<string, string | number>();
  let raw: string;
  try {
    raw = readFileSync(jsonPath, "utf8");
  } catch {
    return out;
  }
  try {
    const parsed = JSON.parse(raw) as {
      constants?: ReadonlyArray<{
        readonly name: string;
        readonly value: string | number;
      }>;
    };
    for (const c of parsed.constants ?? []) {
      out.set(c.name, c.value);
    }
  } catch {
    /* malformed previous file — fall through to empty map */
  }
  return out;
};

// ─── Entry point ──────────────────────────────────────────────────────────

const main = (): void => {
  mkdirSync(constantsDir, { recursive: true });
  const valuesJsonPath = resolve(constantsDir, "values.json");
  // Snapshot previous values BEFORE rewriting them; the bake step
  // needs the old literal to know what to find-and-replace.
  const previousValues = loadPreviousValues(valuesJsonPath);
  const constants = collect();
  writeFileSync(resolve(constantsDir, "values.mdx"), renderMdx(constants));
  writeFileSync(valuesJsonPath, renderJson(constants));

  const constantsByName = new Map<string, Constant>(
    constants.map((c) => [c.name, c]),
  );
  const docsRoot = resolve(workspaceRoot, "docs");
  const docFiles = walkDocFiles(docsRoot);
  const readmePath = resolve(workspaceRoot, "README.md");
  const allFiles = [...docFiles, readmePath];

  const allBakes: BakeRecord[] = [];
  const allFailures: BakeFailure[] = [];
  for (const f of allFiles) {
    const result = bakeFile(f, constantsByName, previousValues);
    allBakes.push(...result.records);
    allFailures.push(...result.failures);
  }

  if (allFailures.length > 0) {
    for (const f of allFailures) {
      console.error(
        `[generate-constants-snippets] FAIL ${f.file}: ${f.reason} '${f.constant}'`,
      );
    }
    process.exit(1);
  }

  const headlines = constants
    .filter(
      (c) =>
        c.name === "PROTOCOL_VERSION" ||
        c.name === "DEFAULT_SERVER_PORT" ||
        c.name === "QUICKSTART_PORT",
    )
    .map((c) => `${c.name}=${c.value}`)
    .join(", ");
  const bakedSuffix =
    allBakes.length === 0
      ? "no consumer files needed re-baking"
      : `re-baked ${allBakes.length} literal(s) across ${new Set(allBakes.map((b) => b.file)).size} file(s)`;
  console.log(
    `[generate-constants-snippets] wrote ${constants.length} constants (${headlines}) → docs/snippets/constants/; ${bakedSuffix}`,
  );
};

main();
