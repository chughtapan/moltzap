#!/usr/bin/env node
/**
 * @file Doc-imports-resolve gate. Scans every `from "@moltzap/*"`
 * import statement that appears in a `.mdx`/`.md` file under `docs/`
 * (or in the repo-root `README.md`), parses each referenced package's
 * `exports` map from the workspace package root, and verifies:
 *
 *   1. The exact subpath (`.` or `./&lt;name>`) resolves to a published
 *      entry — the doc cannot dangle on a path that isn't in the
 *      exports map.
 *   2. Every named binding in the `import { ... }` clause exists in
 *      the resolved source file's top-level `export` declarations.
 *
 * The named-binding check parses the resolved file via the TypeScript
 * compiler API (the AST is the contract). When the resolved entry is
 * a `.d.ts` or `.js` build output (`./dist/&lt;name>.js`), the gate also
 * tries the matching `src/.../&lt;name>.ts` so the check works in
 * pre-build dev trees.
 *
 * Exit codes:
 *   0 — every doc-side import resolves and every named binding is
 *       exported.
 *   1 — at least one violation; details printed with file:line +
 *       remediation hint.
 *
 * Wired into `pnpm docs:check:drift` (via
 * `pnpm docs:check:doc-imports-resolve`) so a doc that references a
 * non-existent subpath or symbol fails the docs gate, not the
 * downstream consumer build.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const workspaceRoot = resolve(scriptDir, "..", "..");

const docsDir = resolve(workspaceRoot, "docs");

const workspacePackageRoot = resolve(workspaceRoot, "packages");

interface ExportTarget {
  /** Filesystem path the subpath resolves to (e.g. `dist/index.js`). */
  readonly resolvedPath: string;
  /** Best-effort `src/...` companion (for pre-build trees). */
  readonly sourceCandidate?: string;
}

interface PackageInfo {
  readonly packageDir: string;
  /** Map of subpath ("." or "./&lt;name>") → resolved entry + src candidate. */
  readonly subpaths: ReadonlyMap<string, ExportTarget>;
}

interface ExportSet {
  /** Names of values + types exported. */
  readonly names: ReadonlySet<string>;
  /** True when at least one `export * from "..."` appears (we cannot
   *  enumerate transitive exports without resolving all star sources;
   *  treat any name as potentially valid in that case). */
  readonly hasStarExport: boolean;
}

const STAR_EXPORT = "*";

interface DocImport {
  readonly absFile: string;
  readonly line: number;
  readonly raw: string;
  readonly packageName: string;
  readonly subpath: string;
  readonly namedBindings: readonly string[];
  /** True when the import is bare (`import "..."`) or default-only; we
   *  still verify subpath resolution but skip named-binding checks. */
  readonly hasNamedClause: boolean;
}

/** Captures named clauses and module specifiers after multiline imports are folded into one logical line. */
const IMPORT_RE =
  // eslint-disable-next-line sonarjs/regex-complexity -- This expression preserves the supported import-clause grammar, including multiline named imports.
  /^\s*import\s+(?:type\s+)?(?:(\{[\s\S]*?\}|\w+|\*\s+as\s+\w+)(?:\s*,\s*(\{[\s\S]*?\}|\w+|\*\s+as\s+\w+))?\s+from\s+)?["'](@moltzap\/[^"']+)["']/;

interface FoldedLine {
  readonly text: string;
  readonly startLine: number;
}

const MULTI_LINE_FOLD_CAP = 50;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly kind:
    | "unknown-package"
    | "unknown-subpath"
    | "missing-target"
    | "missing-export";
  readonly detail: string;
}

function main(): void {
  const packages = readPackages();
  const docFiles = walkDocs(docsDir);
  const readmePath = resolve(workspaceRoot, "README.md");
  const targets = [...docFiles, readmePath];
  const allImports: DocImport[] = [];
  for (const f of targets) {
    allImports.push(...collectImports(f));
  }
  const violations = scanImports(allImports, packages);
  if (violations.length === 0) {
    console.log(
      `[check-doc-imports-resolve] OK — ${targets.length} files scanned, ${allImports.length} @moltzap imports validated.`,
    );
    process.exit(0);
  }
  console.error(
    `[check-doc-imports-resolve] FAIL — ${violations.length} violation(s):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.kind}]`);
    console.error(`    ${v.text}`);
    console.error(`    → ${v.detail}\n`);
  }
  process.exit(1);
}

function readPackages(): ReadonlyMap<string, PackageInfo> {
  const out = new Map<string, PackageInfo>();
  for (const entry of readdirSync(workspacePackageRoot)) {
    const pkgDir = resolve(workspacePackageRoot, entry);
    const parsed = readPackageManifest(resolve(pkgDir, "package.json"));
    if (!parsed?.name) {
      continue;
    }
    const subpaths = readSubpaths(pkgDir, parsed.exports ?? {});
    out.set(parsed.name, { packageDir: pkgDir, subpaths });
  }
  return out;
}

function walkDocs(root: string): string[] {
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
}

function isDocFile(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

function collectImports(absPath: string): readonly DocImport[] {
  const text = safeRead(absPath);
  if (text === null || isHistoricalSupersededDocument(text)) {
    return [];
  }
  return joinMultiLineImports(text.split("\n")).flatMap((foldedLine) => {
    const { text: line, startLine } = foldedLine;
    const match = IMPORT_RE.exec(line);
    return match === null ? [] : parseImport(absPath, line, startLine, match);
  });
}

function parseImport(
  absPath: string,
  line: string,
  startLine: number,
  m: RegExpExecArray,
): readonly DocImport[] {
  const specifier = m[3] ?? "";
  const [scope, packageOnly, ...rest] = specifier.split("/");
  if (scope !== "@moltzap" || packageOnly === undefined) {
    return [];
  }
  const namedClauseRaw = [m[1], m[2]]
    .filter((c): c is string => c !== undefined && c.startsWith("{"))
    .join("");
  return [
    {
      absFile: absPath,
      line: startLine,
      raw: line.trim(),
      packageName: `${scope}/${packageOnly}`,
      subpath: rest.length === 0 ? "." : `./${rest.join("/")}`,
      namedBindings: parseNamedBindings(namedClauseRaw),
      hasNamedClause: namedClauseRaw.length > 0,
    },
  ];
}

/** Strip type prefixes and aliases so only the exported binding name is checked. */
function parseNamedBindings(clause: string): readonly string[] {
  return clause
    .replace(/[{}]/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const noType = s.replace(/^type\s+/, "");
      // eslint-disable-next-line sonarjs/slow-regex -- Only repository-owned import clauses reach this expression.
      const [name] = noType.split(/\s+as\s+/);
      return (name ?? "").trim();
    })
    .filter((s) => s.length > 0);
}

/**
 * Historical handoffs preserve their reviewed package imports. Only an
 * explicit opening Status marker containing both HISTORICAL and SUPERSEDED
 * exempts a document; ordinary live docs continue through the resolver even
 * if their prose mentions either word elsewhere.
 */
function isHistoricalSupersededDocument(text: string): boolean {
  const opening = text.split("\n").slice(0, 20).join("\n");
  // eslint-disable-next-line sonarjs/slow-regex -- The input is bounded, repository-owned documentation or a fixed test fixture.
  return /^Status:\s+.*\bHISTORICAL\b.*\bSUPERSEDED\b.*$/m.test(opening);
}

/**
 * Pre-folds multi-line `import { ... } from "..."` statements onto one
 * logical line so the single-line `IMPORT_RE` can match them. Detection:
 * a line starts with `import` AND opens a `{` that isn't closed on the
 * same line AND has no `from "..."` clause yet. Accumulates following
 * lines (joined with spaces) until the matching `}` appears with a
 * `from "..."` clause on the same line, capping at 50 lines to bound
 * pathological input. Non-import lines pass through unchanged. Returns
 * the start line of each folded statement for accurate error citations.
 */
function joinMultiLineImports(
  rawLines: readonly string[],
): readonly FoldedLine[] {
  const out: FoldedLine[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i] ?? "";
    const opens = /^\s*import\b/.test(line) && line.includes("{");
    const closesSameLine =
      opens && line.includes("}") && /\bfrom\s+["']/.test(line);
    if (opens && !closesSameLine) {
      const folded = foldImport(rawLines, i, line);
      out.push({ text: folded.text, startLine: i + 1 });
      i = folded.nextLine;
      continue;
    }
    out.push({ text: line, startLine: i + 1 });
    i++;
  }
  return out;
}

function scanImports(
  imports: readonly DocImport[],
  packages: ReadonlyMap<string, PackageInfo>,
): readonly Violation[] {
  return imports.flatMap((imp) => scanImport(imp, packages));
}

function scanImport(
  imp: DocImport,
  packages: ReadonlyMap<string, PackageInfo>,
): readonly Violation[] {
  const out: Violation[] = [];
  const pkg = packages.get(imp.packageName);
  if (pkg === undefined) {
    out.push({
      file: relative(workspaceRoot, imp.absFile),
      line: imp.line,
      text: imp.raw,
      kind: "unknown-package",
      detail: `Package '${imp.packageName}' is not in packages/.`,
    });
    return out;
  }
  const target = pkg.subpaths.get(imp.subpath);
  if (target === undefined) {
    out.push({
      file: relative(workspaceRoot, imp.absFile),
      line: imp.line,
      text: imp.raw,
      kind: "unknown-subpath",
      detail: `Package '${imp.packageName}' has no '${imp.subpath}' entry in its exports map. Published subpaths: ${[...pkg.subpaths.keys()].sort((a, b) => (a < b ? -1 : Number(a > b))).join(", ")}.`,
    });
    return out;
  }
  const sourceExists = sourceCandidateExists(target);
  const resolvedExists = fileExists(target.resolvedPath);
  if (!sourceExists && !resolvedExists) {
    out.push({
      file: relative(workspaceRoot, imp.absFile),
      line: imp.line,
      text: imp.raw,
      kind: "missing-target",
      detail: `Package '${imp.packageName}${imp.subpath === "." ? "" : imp.subpath}' resolves to neither ${target.sourceCandidate === undefined ? "a source candidate" : relative(workspaceRoot, target.sourceCandidate)} nor ${relative(workspaceRoot, target.resolvedPath)}.`,
    });
    return out;
  }
  return scanNamedBindings(imp, target, sourceExists);
}

function scanNamedBindings(
  imp: DocImport,
  target: ExportTarget,
  sourceExists: boolean,
): readonly Violation[] {
  const out: Violation[] = [];
  if (!imp.hasNamedClause || imp.namedBindings.length === 0) {
    return out;
  }

  const candidate = preferredTarget(target, sourceExists);
  const exportSet = collectExports(candidate);
  if (exportSet.hasStarExport) {
    return out;
  }
  for (const name of imp.namedBindings) {
    if (!exportSet.names.has(name)) {
      out.push({
        file: relative(workspaceRoot, imp.absFile),
        line: imp.line,
        text: imp.raw,
        kind: "missing-export",
        detail: `'${name}' is not exported from '${imp.packageName}${imp.subpath === "." ? "" : imp.subpath}' (checked ${relative(workspaceRoot, candidate)}).`,
      });
    }
  }
  return out;
}

function collectExports(filePath: string): ExportSet {
  const text = safeRead(filePath);
  if (text === null) {
    return { names: new Set([STAR_EXPORT]), hasStarExport: false };
  }
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  let hasStarExport = false;
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause === undefined) {
        hasStarExport = true;
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const spec of node.exportClause.elements) {
          names.add(spec.name.text);
        }
      }
    } else {
      collectDeclarationNames(node, names);
    }
  };
  source.forEachChild(visit);
  return { names, hasStarExport };
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
    // eslint-disable-next-line agent-code-guard/bare-catch -- Missing optional source files are represented as null for the existing fallback path.
  } catch {
    return null;
  }
}

/** Unreadable or malformed manifests are not workspace packages for this gate. */
function readPackageManifest(path: string): {
  name?: string;
  exports?: Record<string, unknown>;
} | null {
  try {
    return /* Safe because Workspace manifests are repository-owned JSON; optional fields retain the gate's permissive discovery. */ JSON.parse(
      readFileSync(path, "utf8"),
    ) as {
      name?: string;
      exports?: Record<string, unknown>;
    };
    // eslint-disable-next-line agent-code-guard/bare-catch -- Package discovery intentionally skips unreadable or malformed manifests.
  } catch {
    return null;
  }
}

function foldImport(
  lines: readonly string[],
  i: number,
  line: string,
): {
  text: string;
  nextLine: number;
} {
  let text = line;
  let j = i + 1;
  const stop = Math.min(lines.length, i + 1 + MULTI_LINE_FOLD_CAP);
  while (j < stop) {
    text += ` ${lines[j] ?? ""}`;
    if (
      (lines[j] ?? "").includes("}") &&
      /\bfrom\s+["'][^"']+["']/.test(text)
    ) {
      j++;
      break;
    }
    j++;
  }
  return { text, nextLine: j };
}

function collectDeclarationNames(node: ts.Node, names: Set<string>): void {
  if (!isNamedDeclaration(node)) {
    return;
  }
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
    return;
  }
  if (ts.isVariableStatement(node)) {
    collectVariableNames(node, names);
  } else if (node.name !== undefined) {
    names.add(node.name.text);
  }
}

function isNamedDeclaration(
  node: ts.Node,
): node is
  | ts.VariableStatement
  | ts.FunctionDeclaration
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.EnumDeclaration
  | ts.ModuleDeclaration {
  return (
    ts.isVariableStatement(node) ||
    ts.isFunctionDeclaration(node) ||
    isOtherDeclaration(node)
  );
}

function readSubpaths(
  pkgDir: string,
  exports: Record<string, unknown>,
): ReadonlyMap<string, ExportTarget> {
  const subpaths = new Map<string, ExportTarget>();
  for (const [sub, target] of Object.entries(exports)) {
    const resolved = resolveExportTarget(target);
    if (resolved === null) {
      continue;
    }
    const resolvedAbs = resolve(pkgDir, resolved);
    const sourceCandidate = guessSourcePath(pkgDir, resolved);
    subpaths.set(sub, {
      resolvedPath: resolvedAbs,
      ...(sourceCandidate === null ? {} : { sourceCandidate }),
    });
  }
  return subpaths;
}

function collectVariableNames(
  node: ts.VariableStatement,
  names: Set<string>,
): void {
  for (const decl of node.declarationList.declarations) {
    if (ts.isIdentifier(decl.name)) {
      names.add(decl.name.text);
    }
  }
}

function isOtherDeclaration(node: ts.Node): boolean {
  return (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    isTypeDeclaration(node)
  );
}

function isTypeDeclaration(node: ts.Node): boolean {
  return (
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name))
  );
}

/**
 * Reduces an exports-map entry to a single string path. Accepts either
 * a bare string (`"./dist/index.js"`) or a conditional object (`{
 * "import": "./dist/index.js", "types": "..." }`); prefers `import`,
 * then `default`, then `types`. Returns null when the entry is malformed.
 */
function resolveExportTarget(target: unknown): string | null {
  if (typeof target === "string") {
    return target;
  }
  if (typeof target === "object" && target !== null) {
    const obj =
      /* Safe because Conditional export keys are read as unknown before checking the selected value. */ target as {
        import?: unknown;
        default?: unknown;
        types?: unknown;
      };
    const pick = obj.import ?? obj.default ?? obj.types;
    if (typeof pick === "string") {
      return pick;
    }
  }
  return null;
}

/**
 * Maps a `dist/...` build path to its likely `src/...` source so the
 * named-binding check works on pre-build trees. `dist/foo/index.js` →
 * `src/foo/index.ts`; everything else returns null and the gate falls
 * back to the dist file (which may not exist).
 */
function guessSourcePath(pkgDir: string, distRel: string): string | null {
  if (!distRel.startsWith("./dist/")) {
    return null;
  }
  const after = distRel.slice("./dist/".length);
  const withoutExt = after.replace(/\.(d\.ts|js|mjs|ts)$/, "");
  const candidate = resolve(pkgDir, "src", `${withoutExt}.ts`);
  return candidate;
}

function sourceCandidateExists(target: ExportTarget): boolean {
  return (
    target.sourceCandidate !== undefined && fileExists(target.sourceCandidate)
  );
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
    // eslint-disable-next-line agent-code-guard/bare-catch -- This existence probe reports absent or inaccessible candidates as false.
  } catch {
    return false;
  }
}

/** A source companion takes precedence over build output when it exists. */
function preferredTarget(target: ExportTarget, sourceExists: boolean): string {
  return sourceExists
    ? (target.sourceCandidate ?? target.resolvedPath)
    : target.resolvedPath;
}

main();
