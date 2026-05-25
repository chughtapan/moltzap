#!/usr/bin/env tsx
/**
 * @file Doc-imports-resolve gate. Scans every `from "@moltzap/*"`
 * import statement that appears in a `.mdx`/`.md` file under `docs/`
 * (or in the repo-root `README.md`), parses each referenced package's
 * `exports` map out of its `package.json`, and verifies two things:
 *
 *   1. The exact subpath (`.` or `./<name>`) resolves to a published
 *      entry — the doc cannot dangle on a path that isn't in the
 *      exports map.
 *   2. Every named binding in the `import { ... }` clause exists in
 *      the resolved source file's top-level `export` declarations.
 *
 * The named-binding check parses the resolved file via the TypeScript
 * compiler API (the AST is the contract). When the resolved entry is
 * a `.d.ts` or `.js` build output (`./dist/<name>.js`), the gate also
 * tries the matching `src/.../<name>.ts` so the check works in
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
const workspaceRoot = resolve(scriptDir, "..");
const docsDir = resolve(workspaceRoot, "docs");
const packagesDir = resolve(workspaceRoot, "packages");

// ─── Workspace package discovery ──────────────────────────────────────────

interface ExportTarget {
  /** Filesystem path the subpath resolves to (e.g. `dist/index.js`). */
  readonly resolvedPath: string;
  /** Best-effort `src/...` companion (for pre-build trees). */
  readonly sourceCandidate?: string;
}

interface PackageInfo {
  readonly packageDir: string;
  /** Map of subpath ("." or "./<name>") → resolved entry + src candidate. */
  readonly subpaths: ReadonlyMap<string, ExportTarget>;
}

const readPackages = (): ReadonlyMap<string, PackageInfo> => {
  const out = new Map<string, PackageInfo>();
  for (const entry of readdirSync(packagesDir)) {
    const pkgDir = resolve(packagesDir, entry);
    const pkgJsonPath = resolve(pkgDir, "package.json");
    let parsed: { name?: string; exports?: Record<string, unknown> };
    try {
      parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as typeof parsed;
    } catch {
      continue;
    }
    if (!parsed.name) continue;
    const subpaths = new Map<string, ExportTarget>();
    for (const [sub, target] of Object.entries(parsed.exports ?? {})) {
      const resolved = resolveExportTarget(target);
      if (resolved === null) continue;
      const resolvedAbs = resolve(pkgDir, resolved);
      const sourceCandidate = guessSourcePath(pkgDir, resolved);
      subpaths.set(sub, {
        resolvedPath: resolvedAbs,
        ...(sourceCandidate === null ? {} : { sourceCandidate }),
      });
    }
    out.set(parsed.name, { packageDir: pkgDir, subpaths });
  }
  return out;
};

/**
 * Reduce an exports-map entry to a single string path. Accepts either
 * a bare string (`"./dist/index.js"`) or a conditional object (`{
 * "import": "./dist/index.js", "types": "..." }`); prefers `import`
 * over `default`. Returns null when the entry is malformed.
 */
const resolveExportTarget = (target: unknown): string | null => {
  if (typeof target === "string") return target;
  if (typeof target === "object" && target !== null) {
    const obj = target as Record<string, unknown>;
    const pick = obj["import"] ?? obj["default"] ?? obj["types"];
    if (typeof pick === "string") return pick;
  }
  return null;
};

/**
 * Map a `dist/...` build path to its likely `src/...` source so the
 * named-binding check works on pre-build trees. `dist/foo/index.js` →
 * `src/foo/index.ts`; everything else returns null and the gate falls
 * back to the dist file (which may not exist).
 */
const guessSourcePath = (pkgDir: string, distRel: string): string | null => {
  if (!distRel.startsWith("./dist/")) return null;
  const after = distRel.slice("./dist/".length);
  const withoutExt = after.replace(/\.(d\.ts|js|mjs|ts)$/, "");
  const candidate = resolve(pkgDir, "src", `${withoutExt}.ts`);
  return candidate;
};

// ─── Resolved-file export collection ──────────────────────────────────────

interface ExportSet {
  /** Names of values + types exported. */
  readonly names: ReadonlySet<string>;
  /** True when at least one `export * from "..."` appears (we cannot
   *  enumerate transitive exports without resolving all star sources;
   *  treat any name as potentially valid in that case). */
  readonly hasStarExport: boolean;
}

const STAR_EXPORT = "*";

const collectExports = (filePath: string): ExportSet => {
  const text = safeRead(filePath);
  if (text === null)
    return { names: new Set([STAR_EXPORT]), hasStarExport: false };
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
        // `export * from "..."` — cannot enumerate without resolution.
        hasStarExport = true;
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const spec of node.exportClause.elements) {
          names.add(spec.name.text);
        }
      }
    } else if (
      ts.isVariableStatement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      const mods = ts.canHaveModifiers(node)
        ? ts.getModifiers(node)
        : undefined;
      const exported = mods?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!exported) return;
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
        }
      } else if (node.name !== undefined) {
        names.add(node.name.text);
      }
    }
  };
  source.forEachChild(visit);
  return { names, hasStarExport };
};

const safeRead = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const fileExists = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// ─── Doc walker ───────────────────────────────────────────────────────────

const isDocFile = (path: string): boolean =>
  path.endsWith(".md") || path.endsWith(".mdx");

const walkDocs = (root: string): string[] => {
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

// ─── Import parsing ───────────────────────────────────────────────────────

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

// Matches `import [<clause>] from "@moltzap/<pkg>[/<sub>]"`. Captures
// the raw clause text + the full module specifier so we can split the
// package name from the subpath downstream. The `[\s\S]` inside the
// named-clause groups lets the regex span multiple lines after the
// statement has been folded by `joinMultiLineImports` below — supports
// the common `import {\n  Foo,\n  Bar,\n} from "@moltzap/..."` shape.
const IMPORT_RE =
  /^\s*import\s+(?:type\s+)?(?:(\{[\s\S]*?\}|\w+|\*\s+as\s+\w+)(?:\s*,\s*(\{[\s\S]*?\}|\w+|\*\s+as\s+\w+))?\s+from\s+)?["'](@moltzap\/[^"']+)["']/;

interface FoldedLine {
  readonly text: string;
  readonly startLine: number;
}

/**
 * Pre-fold multi-line `import { ... } from "..."` statements onto one
 * logical line so the single-line `IMPORT_RE` can match them. Detection:
 * a line starts with `import` AND opens a `{` that isn't closed on the
 * same line AND has no `from "..."` clause yet. Accumulates following
 * lines (joined with spaces) until the matching `}` appears with a
 * `from "..."` clause on the same line, capping at 50 lines to bound
 * pathological input. Non-import lines pass through unchanged. Returns
 * the start line of each folded statement for accurate error citations.
 */
const MULTI_LINE_FOLD_CAP = 50;
const joinMultiLineImports = (
  rawLines: readonly string[],
): readonly FoldedLine[] => {
  const out: FoldedLine[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i] ?? "";
    const opens = /^\s*import\b/.test(line) && line.includes("{");
    const closesSameLine =
      opens && line.includes("}") && /\bfrom\s+["']/.test(line);
    if (opens && !closesSameLine) {
      let buf = line;
      let j = i + 1;
      const stop = Math.min(rawLines.length, i + 1 + MULTI_LINE_FOLD_CAP);
      while (j < stop) {
        buf += ` ${rawLines[j] ?? ""}`;
        if (
          (rawLines[j] ?? "").includes("}") &&
          /\bfrom\s+["'][^"']+["']/.test(buf)
        ) {
          j++;
          break;
        }
        j++;
      }
      out.push({ text: buf, startLine: i + 1 });
      i = j;
      continue;
    }
    out.push({ text: line, startLine: i + 1 });
    i++;
  }
  return out;
};

const collectImports = (absPath: string): readonly DocImport[] => {
  const text = safeRead(absPath);
  if (text === null) return [];
  const out: DocImport[] = [];
  const folded = joinMultiLineImports(text.split("\n"));
  for (const { text: line, startLine } of folded) {
    const m = IMPORT_RE.exec(line);
    if (m === null) continue;
    const specifier = m[3] ?? "";
    const [scope, packageOnly, ...rest] = specifier.split("/");
    if (scope !== "@moltzap" || packageOnly === undefined) continue;
    const packageName = `${scope}/${packageOnly}`;
    const subpath = rest.length === 0 ? "." : `./${rest.join("/")}`;
    const namedClauseRaw = [m[1], m[2]]
      .filter((c): c is string => c !== undefined && c.startsWith("{"))
      .join("");
    const namedBindings = namedClauseRaw
      .replace(/[{}]/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        // Strip `type ` prefix + `as <alias>` for the symbol-name check.
        const noType = s.replace(/^type\s+/, "");
        const [name] = noType.split(/\s+as\s+/);
        return (name ?? "").trim();
      })
      .filter((s) => s.length > 0);
    out.push({
      absFile: absPath,
      line: startLine,
      raw: line.trim(),
      packageName,
      subpath,
      namedBindings,
      hasNamedClause: namedClauseRaw.length > 0,
    });
  }
  return out;
};

// ─── Violation reporting ──────────────────────────────────────────────────

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly kind: "unknown-package" | "unknown-subpath" | "missing-export";
  readonly detail: string;
}

const scanImports = (
  imports: readonly DocImport[],
  packages: ReadonlyMap<string, PackageInfo>,
): readonly Violation[] => {
  const out: Violation[] = [];
  for (const imp of imports) {
    const pkg = packages.get(imp.packageName);
    if (pkg === undefined) {
      out.push({
        file: relative(workspaceRoot, imp.absFile),
        line: imp.line,
        text: imp.raw,
        kind: "unknown-package",
        detail: `Package '${imp.packageName}' is not in packages/.`,
      });
      continue;
    }
    const target = pkg.subpaths.get(imp.subpath);
    if (target === undefined) {
      out.push({
        file: relative(workspaceRoot, imp.absFile),
        line: imp.line,
        text: imp.raw,
        kind: "unknown-subpath",
        detail: `Package '${imp.packageName}' has no '${imp.subpath}' entry in its exports map. Published subpaths: ${[...pkg.subpaths.keys()].sort().join(", ")}.`,
      });
      continue;
    }
    if (!imp.hasNamedClause || imp.namedBindings.length === 0) continue;
    // Prefer the src candidate; fall back to the resolved dist file.
    const candidate =
      target.sourceCandidate !== undefined && fileExists(target.sourceCandidate)
        ? target.sourceCandidate
        : target.resolvedPath;
    const exportSet = collectExports(candidate);
    if (exportSet.hasStarExport) continue;
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
  }
  return out;
};

// ─── Entry point ──────────────────────────────────────────────────────────

const main = (): void => {
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
};

main();
