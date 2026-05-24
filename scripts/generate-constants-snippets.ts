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
 *     constant as a JSX variable so docs can interpolate them with
 *     `{PROTOCOL_VERSION}`.
 *
 * Wired into `pnpm docs:generate`; `pnpm docs:check:drift` then catches
 * any drift between the snippets and the source-of-truth files.
 *
 * Adding a new constant: append an entry to `CONSTANT_SPECS`, point it
 * at the source file + identifier, and the generator + the gate pick
 * it up automatically.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

/**
 * Find a top-level `const NAME = <Literal>` declaration whose initializer
 * is a string or numeric literal (optionally with a trailing
 * `as <TypeReference>`).
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
      // Unwrap `<literal> as <TypeRef>`.
      const inner = ts.isAsExpression(init) ? init.expression : init;
      if (
        ts.isStringLiteral(inner) ||
        ts.isNoSubstitutionTemplateLiteral(inner)
      ) {
        found = inner.text;
      } else if (ts.isNumericLiteral(inner)) {
        found = Number(inner.text);
      }
    }
  }
  return found === null
    ? err(
        `identifier '${identifier}' not found as a top-level literal in ${filePath}`,
      )
    : ok(found);
};

/**
 * Walk an object literal initializer + collect numeric-literal fields
 * keyed by property name. Used for `buildHelloOk`'s policy block —
 * the AST is `Effect.sync(() => { ... return { policy: { ... } }; })`,
 * so we recurse into the function body and pick out the `policy: { ... }`
 * property assignment.
 */
const readHelloPolicyNumbers = (
  filePath: string,
): ReadResult<Record<string, number>> => {
  const src = parseSource(filePath);
  const want = new Set([
    "maxMessageBytes",
    "maxPartsPerMessage",
    "maxTextLength",
    "maxGroupParticipants",
    "heartbeatIntervalMs",
    "messagesPerMinute",
    "requestsPerMinute",
  ]);
  const out: Record<string, number> = {};
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const key = node.name.text;
      if (want.has(key) && ts.isNumericLiteral(node.initializer)) {
        out[key] = Number(node.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  const missing = [...want].filter((k) => !(k in out));
  return missing.length === 0
    ? ok(out)
    : err(
        `buildHelloOk: missing numeric fields in ${filePath}: ${missing.join(", ")}`,
      );
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
    resolve(workspaceRoot, "packages/protocol/src/version.ts"),
    "PROTOCOL_VERSION",
  );
  const defaultAppId = readTopLevelLiteral(
    resolve(workspaceRoot, "packages/protocol/src/task/ids.ts"),
    "DEFAULT_APP_ID",
  );
  const defaultServerPort = readTopLevelLiteral(
    resolve(workspaceRoot, "packages/server/src/app/config.ts"),
    "DEFAULT_SERVER_PORT",
  );
  const apiKeyPrefix = readTopLevelLiteral(
    resolve(
      workspaceRoot,
      "packages/server/src/identity/services/agent-auth.ts",
    ),
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
      "packages/protocol/src/version.ts",
      protocolVersion,
      "Current wire-protocol version emitted in HelloOk + accepted in `network/connect`.",
    ),
    requireString(
      "DEFAULT_APP_ID",
      "packages/protocol/src/task/ids.ts",
      defaultAppId,
      "Built-in unmoderated default-app UUID. Conversations created without an explicit app bind here.",
    ),
    requireNumber(
      "DEFAULT_SERVER_PORT",
      "packages/server/src/app/config.ts",
      defaultServerPort,
      "Code-level fallback port used by ServerConfigLoader when PORT is unset.",
    ),
    requireString(
      "API_KEY_PREFIX",
      "packages/server/src/identity/services/agent-auth.ts",
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

  const helloPolicy = readHelloPolicyNumbers(
    resolve(
      workspaceRoot,
      "packages/server/src/task/handlers/connect.handlers.ts",
    ),
  );
  if (helloPolicy._tag === "err") {
    console.error(`generate-constants-snippets: ${helloPolicy.reason}`);
    process.exit(1);
  }

  const helloEntries = Object.entries(helloPolicy.value).map(
    ([key, value]): NumberConstant => ({
      kind: "number",
      name: `HELLO_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`,
      value,
      sourcePath: "packages/server/src/task/handlers/connect.handlers.ts",
      note: `HelloOk policy field: ${key}`,
    }),
  );

  return [
    ...constants.filter((c): c is Constant => c !== null),
    ...helloEntries,
  ];
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

// ─── Entry point ──────────────────────────────────────────────────────────

const main = (): void => {
  mkdirSync(constantsDir, { recursive: true });
  const constants = collect();
  writeFileSync(resolve(constantsDir, "values.mdx"), renderMdx(constants));
  writeFileSync(resolve(constantsDir, "values.json"), renderJson(constants));
  const headlines = constants
    .filter(
      (c) =>
        c.name === "PROTOCOL_VERSION" ||
        c.name === "DEFAULT_SERVER_PORT" ||
        c.name === "QUICKSTART_PORT",
    )
    .map((c) => `${c.name}=${c.value}`)
    .join(", ");
  console.log(
    `[generate-constants-snippets] wrote ${constants.length} constants (${headlines}) → docs/snippets/constants/`,
  );
};

main();
