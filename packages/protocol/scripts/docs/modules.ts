/**
 * @file Per-folder MODULE.md + Mintlify MDX generator.
 *
 * Folders opt in by adding a leading file-level JSDoc block to
 * `index.ts`. Output is deterministic: sorted exports, LF endings,
 * stable section order.
 */
import { FileSystem, Path } from "@effect/platform";
import { Effect } from "effect";
import {
  folderOf,
  ReflectionKind,
  type TypeDocCache,
  type TypeDocExport,
} from "./typedoc-load.js";

export interface ModuleRenderResult {
  readonly folder: string;
  readonly h1: string;
  readonly pageSlug: string;
}

export interface ModuleRenderConfig {
  readonly workspaceRoot: string;
  readonly docsModulesDir: string;
}

interface EnrichedExport extends TypeDocExport {
  readonly signatureText: string | null;
}

interface MissingJsDoc {
  readonly _tag: "MissingJsDoc";
  readonly folder: string;
}

const MissingJsDoc = (folder: string): MissingJsDoc => ({
  _tag: "MissingJsDoc",
  folder,
});

/**
 * Render MODULE.md + Mintlify MDX for every folder whose `index.ts`
 * has a leading file-level JSDoc block. Folders without that block
 * print a warning and are skipped (loud, not silent).
 */
export const generateModuleDocs = (
  cache: TypeDocCache,
  config: ModuleRenderConfig,
): Effect.Effect<
  ReadonlyArray<ModuleRenderResult>,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const folders = yield* discoverFolders(cache, config);
    const rendered: ModuleRenderResult[] = [];
    const warnings: string[] = [];
    for (const folder of folders) {
      const result = yield* renderFolder(folder, cache, config, path).pipe(
        Effect.catchTag("MissingJsDoc", (e) => {
          warnings.push(e.folder);
          return Effect.succeed(null);
        }),
      );
      if (result !== null) rendered.push(result);
    }
    if (warnings.length > 0) yield* emitWarnings(warnings);
    return rendered;
  }).pipe(Effect.withSpan("generateModuleDocs"));

const emitWarnings = (
  folders: ReadonlyArray<string>,
): Effect.Effect<void, never, never> =>
  Effect.sync(() => {
    process.stderr.write(
      `\nMODULE generation skipped ${folders.length} folder(s) without file-level JSDoc on index.ts:\n`,
    );
    for (const f of folders) {
      process.stderr.write(
        `  ${f}/index.ts: add a leading /** ... */ block to opt in\n`,
      );
    }
    process.stderr.write("\n");
  });

const discoverFolders = (
  cache: TypeDocCache,
  config: ModuleRenderConfig,
): Effect.Effect<
  ReadonlyArray<string>,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const seen = new Set<string>();
    for (const ex of cache.all) {
      const folder = folderOf(ex);
      if (!folder.startsWith("packages/")) continue;
      const indexPath = path.resolve(config.workspaceRoot, folder, "index.ts");
      const hasIndex = yield* fs
        .exists(indexPath)
        .pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (hasIndex) seen.add(folder);
    }
    return [...seen].sort();
  });

const renderFolder = (
  folder: string,
  cache: TypeDocCache,
  config: ModuleRenderConfig,
  path: Path.Path,
): Effect.Effect<ModuleRenderResult, MissingJsDoc, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const indexPath = path.resolve(config.workspaceRoot, folder, "index.ts");
    const indexSource = yield* fs
      .readFileString(indexPath)
      .pipe(Effect.catchAll(() => Effect.succeed("")));
    const purpose = readLeadingJsDoc(indexSource);
    if (purpose === null) return yield* Effect.fail(MissingJsDoc(folder));
    const exports = (cache.byFolder.get(folder) ?? []).filter(isBehavioral);
    const enriched = yield* enrichWithSignatures(exports, fs, path, config);
    const pkg = packageSlugFor(folder, path);
    const pageSlug = `${pkg}/${pathFromPackageSrc(folder, path) || path.basename(folder)}`;
    const h1 = `# ${pageSlug}`;
    const body = renderMarkdown({
      h1,
      subtitle: `_\`${folder}\`_`,
      purpose,
      exports: enriched,
      folder,
      path,
    });
    yield* writeAtomic(
      fs,
      path.resolve(config.workspaceRoot, folder, "MODULE.md"),
      body,
    );
    yield* writeAtomic(
      fs,
      path.resolve(config.docsModulesDir, `${pageSlug}.mdx`),
      `${renderFrontmatter({ title: pageSlug, description: firstSentence(purpose) })}\n${body}`,
    );
    return { folder, h1, pageSlug };
  });

const enrichWithSignatures = (
  exports: ReadonlyArray<TypeDocExport>,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: ModuleRenderConfig,
): Effect.Effect<ReadonlyArray<EnrichedExport>, never, never> =>
  Effect.gen(function* () {
    const fileCache = new Map<string, string>();
    const enriched: EnrichedExport[] = [];
    for (const ex of exports) {
      const src = ex.sources[0];
      if (!src) {
        enriched.push({ ...ex, signatureText: null });
        continue;
      }
      let source = fileCache.get(src.fileName);
      if (source === undefined) {
        const abs = path.resolve(config.workspaceRoot, src.fileName);
        source = yield* fs
          .readFileString(abs)
          .pipe(Effect.catchAll(() => Effect.succeed("")));
        fileCache.set(src.fileName, source);
      }
      enriched.push({
        ...ex,
        signatureText: extractSignatureText(source, src.line, ex.kind),
      });
    }
    return enriched;
  });

const writeAtomic = (
  fs: FileSystem.FileSystem,
  absolutePath: string,
  content: string,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const dir = absolutePath.slice(0, absolutePath.lastIndexOf("/"));
    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.catchAll(() => Effect.void));
    const tmp = `${absolutePath}.tmp.${process.pid}`;
    yield* fs
      .writeFileString(tmp, content)
      .pipe(Effect.catchAll(() => Effect.void));
    yield* fs
      .rename(tmp, absolutePath)
      .pipe(Effect.catchAll(() => Effect.void));
  });

interface RenderArgs {
  readonly h1: string;
  readonly subtitle: string;
  readonly purpose: string;
  readonly exports: ReadonlyArray<EnrichedExport>;
  readonly folder: string;
  readonly path: Path.Path;
}

function renderMarkdown(args: RenderArgs): string {
  const sorted = [...args.exports].sort((a, b) => a.name.localeCompare(b.name));
  const sections: string[][] = [
    renderHeader(args),
    renderPublicSurface(sorted, args.folder, args.path),
    renderFilesSection(args.exports, args.folder, args.path),
  ];
  return sections.flat().join("\n");
}

function renderHeader(args: RenderArgs): string[] {
  return [
    args.h1,
    "",
    args.subtitle,
    "",
    "## Purpose",
    "",
    args.purpose.trim(),
    "",
  ];
}

function renderPublicSurface(
  sorted: ReadonlyArray<EnrichedExport>,
  folder: string,
  path: Path.Path,
): string[] {
  const lines: string[] = ["## Public surface", ""];
  if (sorted.length === 0) {
    lines.push("_No exports surfaced from this folder._", "");
    return lines;
  }
  for (const ex of sorted) lines.push(...renderExport(ex, folder, path));
  return lines;
}

function renderExport(
  ex: EnrichedExport,
  folder: string,
  path: Path.Path,
): string[] {
  const lines: string[] = [
    `### ${exportLink(ex, folder, path)}`,
    "",
    `_${ex.kindString}_`,
    "",
  ];
  if (ex.signatureText) lines.push("```ts", ex.signatureText, "```", "");
  const summary = ex.comment?.summary.trim();
  if (summary && summary.length > 0) lines.push(summary, "");
  lines.push(...renderFailures(ex));
  const returns = ex.comment?.tags.find((t) => t.tag === "@returns")?.content;
  if (returns) lines.push(`**Returns:** ${returns}`, "");
  return lines;
}

function exportLink(
  ex: EnrichedExport,
  folder: string,
  path: Path.Path,
): string {
  const src = ex.sources[0];
  if (!src) return `\`${ex.name}\``;
  return `[\`${ex.name}\`](./${path.relative(folder, src.fileName)}#L${src.line})`;
}

function renderFailures(ex: EnrichedExport): string[] {
  const failures = ex.comment?.tags.filter((t) => t.tag === "@failure") ?? [];
  if (failures.length === 0) return [];
  const lines: string[] = ["**Fails with:**", ""];
  for (const f of failures) {
    const parsed = parseFailureTag(f.content);
    const suffix = parsed.when ? ` — ${parsed.when}` : "";
    lines.push(`- \`${parsed.errorName}\`${suffix}`);
  }
  lines.push("");
  return lines;
}

function renderFilesSection(
  exports: ReadonlyArray<EnrichedExport>,
  folder: string,
  path: Path.Path,
): string[] {
  const lines: string[] = ["## Files", ""];
  const files = [
    ...new Set(exports.flatMap((e) => e.sources.map((s) => s.fileName))),
  ]
    .filter((f) => f.startsWith(`${folder}/`))
    .sort();
  if (files.length === 0) {
    lines.push("_No source files tracked under this folder by TypeDoc._");
  } else {
    for (const f of files) lines.push(`- \`${path.basename(f)}\``);
  }
  lines.push("");
  return lines;
}

/**
 * Read the leading JSDoc block of a TypeScript source string. Returns
 * the comment body as plain text (asterisks stripped, leading
 * whitespace normalized) or null if the source has no leading JSDoc.
 *
 * If the block starts with the &amp;#64;file tag, the prose after that tag
 * becomes the summary. Otherwise the whole block (minus the asterisk
 * markup) becomes the summary.
 */
export function readLeadingJsDoc(source: string): string | null {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith("/**")) return null;
  const closeIx = trimmed.indexOf("*/");
  if (closeIx === -1) return null;
  const block = trimmed.slice(0, closeIx);
  const lines = block
    .replace(/^\/\*\*/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trimEnd());
  const stripped = lines.join("\n").trim();
  if (stripped.startsWith("@file ")) {
    return stripped.slice("@file ".length).trim();
  }
  return stripped;
}

/**
 * Parse a `&amp;#64;failure ErrName when prose` tag content into
 * structured form. The convention is documented in workspace
 * CLAUDE.md; this is the single source of truth for the parse rule.
 */
export function parseFailureTag(text: string): {
  readonly errorName: string;
  readonly when: string | null;
} {
  const t = text.trim();
  const ix = t.indexOf(" when ");
  if (ix === -1) {
    const space = t.indexOf(" ");
    if (space === -1) return { errorName: t, when: null };
    return { errorName: t.slice(0, space), when: t.slice(space + 1).trim() };
  }
  return { errorName: t.slice(0, ix).trim(), when: t.slice(ix + 6).trim() };
}

function packageSlugFor(folder: string, path: Path.Path): string {
  const parts = folder.split(path.sep);
  if (parts.length < 2 || parts[0] !== "packages") return "unknown";
  const pkg = parts[1];
  if (pkg === "server") return "server-core";
  return pkg ?? "unknown";
}

function pathFromPackageSrc(folder: string, path: Path.Path): string {
  const parts = folder.split(path.sep);
  const srcIx = parts.indexOf("src");
  if (srcIx === -1) return "";
  return parts.slice(srcIx + 1).join("/");
}

function isBehavioral(ex: TypeDocExport): boolean {
  if (ex.kind === ReflectionKind.Module) return false;
  if (ex.kind === ReflectionKind.Reference) return false;
  return true;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^(.+?[.!?])(\s|$)/s);
  return m ? m[1]!.trim() : trimmed.split("\n")[0]!.trim();
}

function renderFrontmatter(args: {
  readonly title: string;
  readonly description: string;
}): string {
  const t = args.title.replace(/"/g, '\\"');
  const d = args.description.replace(/"/g, '\\"');
  return `---\ntitle: "${t}"\ndescription: "${d}"\n---\n`;
}

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

/**
 * Extract the source text of an export declaration starting at the
 * given 1-based line number. For Function / Method / Variable the cut
 * is at the body's `=>` or `{`. For Class / Interface / TypeAlias /
 * Enum the cut keeps the full balanced body. Returns null when the
 * file is empty or the line is out of range.
 */
export function extractSignatureText(
  source: string,
  oneBasedLine: number,
  kind: number,
): string | null {
  if (source.length === 0) return null;
  const lines = source.split("\n");
  if (oneBasedLine < 1 || oneBasedLine > lines.length) return null;
  const startIx = skipLeadingJsDoc(lines, oneBasedLine - 1);
  if (KEEP_BODY_KINDS.has(kind)) return extractBalancedBody(lines, startIx);
  if (FUNCTION_KINDS.has(kind)) return extractFunctionSignature(lines, startIx);
  return extractBalancedBody(lines, startIx);
}

/**
 * TypeDoc reports the source line of the leading JSDoc block as the
 * declaration's source. Skip past the closing `*​/` so signature
 * extraction starts at the actual code.
 */
function skipLeadingJsDoc(
  lines: ReadonlyArray<string>,
  startIx: number,
): number {
  const first = lines[startIx]?.trimStart() ?? "";
  if (!first.startsWith("/**")) return startIx;
  for (let i = startIx; i < lines.length && i < startIx + 200; i++) {
    if ((lines[i] ?? "").includes("*/")) {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "").trim().length === 0) j++;
      return j;
    }
  }
  return startIx;
}

function extractFunctionSignature(
  lines: ReadonlyArray<string>,
  startIx: number,
): string {
  const collected: string[] = [];
  let depth = 0;
  for (let i = startIx; i < lines.length && i < startIx + 60; i++) {
    const line = lines[i] ?? "";
    collected.push(line);
    for (const ch of line) {
      if (ch === "(" || ch === "[" || ch === "<") depth++;
      else if (ch === ")" || ch === "]" || ch === ">") depth--;
    }
    if (depth <= 0) {
      const joined = collected.join("\n");
      const cut = pickFirstCut(joined, ["=>", "{", ";"]);
      if (cut >= 0) return joined.slice(0, cut).trimEnd();
    }
  }
  return collected.join("\n").trimEnd();
}

/**
 * Accumulate lines from `startIx` until the running token depth
 * (parens, brackets, angles, braces) returns to zero after at least
 * one opening token. For one-line declarations with no brace block
 * (e.g. `export type Foo = string;`) falls back to cutting at the
 * first top-level `;` outside strings.
 */
function extractBalancedBody(
  lines: ReadonlyArray<string>,
  startIx: number,
): string {
  const collected: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = startIx; i < lines.length && i < startIx + 120; i++) {
    const line = lines[i] ?? "";
    collected.push(line);
    for (const ch of line) {
      if (ch === "(" || ch === "[" || ch === "<" || ch === "{") {
        depth++;
        opened = true;
      } else if (ch === ")" || ch === "]" || ch === ">" || ch === "}") {
        depth--;
      }
    }
    if (opened && depth <= 0) return collected.join("\n").trimEnd();
    if (!opened) {
      const semi = findOutsideStrings(collected.join("\n"), ";");
      if (semi >= 0)
        return collected
          .join("\n")
          .slice(0, semi + 1)
          .trimEnd();
    }
  }
  return collected.join("\n").trimEnd();
}

function pickFirstCut(text: string, needles: ReadonlyArray<string>): number {
  const cuts = needles
    .map((n) => findOutsideStrings(text, n))
    .filter((ix) => ix >= 0);
  return cuts.length === 0 ? -1 : Math.min(...cuts);
}

function findOutsideStrings(text: string, needle: string): number {
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i <= text.length - needle.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "\\" && (inSingle || inDouble || inBacktick)) {
      i++;
      continue;
    }
    if (!inDouble && !inBacktick && ch === "'") inSingle = !inSingle;
    else if (!inSingle && !inBacktick && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "`") inBacktick = !inBacktick;
    if (!inSingle && !inDouble && !inBacktick && text.startsWith(needle, i)) {
      return i;
    }
  }
  return -1;
}
