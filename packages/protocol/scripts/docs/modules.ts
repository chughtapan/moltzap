/**
 * @file Per-folder MODULE.md + Mintlify MDX generator.
 *
 * Folders opt in by adding a leading file-level JSDoc block to
 * `index.ts`. Output is deterministic: sorted exports, LF endings,
 * stable section order.
 */
/* eslint-disable sonarjs/null-dereference -- SonarJS treats the strictly typed string and collection callback parameters throughout this generator as nullable. */
import { FileSystem, Path } from "@effect/platform";
import { Effect, Schema } from "effect";
import * as ts from "typescript";
import {
  folderOf,
  ReflectionKind,
  type TypeDocCache,
  type TypeDocExport,
} from "./typedoc-load.js";

/** Describes the result of module render. */
export interface ModuleRenderResult {
  readonly folder: string;
  readonly h1: string;
  readonly pageSlug: string;
}

/** Describes module render config. */
export interface ModuleRenderConfig {
  readonly workspaceRoot: string;
  readonly docsModulesDir: string;
}

/**
 * Base URL for source links emitted in the published MDX twin. MODULE.md
 * uses in-tree relative paths; the MDX lives under `docs/modules/` and
 * needs an absolute permalink so the rendered page resolves under
 * Mintlify.
 */
const SOURCE_LINK_BASE = "https://github.com/chughtapan/moltzap/blob";

/**
 * Active v2 package roots are required generator inputs even before their
 * public barrels contain behavioral exports.
 */
const REQUIRED_V2_MODULE_FOLDERS = [
  "v2/identity/src",
  "v2/router/src",
] as const;

/** TypeDoc package projects required by the active v2 MODULE pages. */
const REQUIRED_V2_PACKAGE_NAMES = [
  "@moltzap/v2-identity",
  "@moltzap/v2-router",
] as const;

/** Package server subpaths admitted to generated v2 module documentation. */
export const REQUIRED_V2_SERVER_SUBPATHS = [
  "@moltzap/v2-identity/server",
  "@moltzap/v2-router/server",
] as const;

interface LinkContext {
  readonly mode: "module-md" | "mdx";
  readonly displayName?: string;
  readonly headingLevel?: number;
}

interface EnrichedExport extends TypeDocExport {
  readonly signatureText: string | null;
}

interface EnrichedSubpath {
  readonly importPath: string;
  readonly exports: readonly EnrichedExport[];
}

interface ResolvedExportDeclaration {
  readonly source?: TypeDocExport["sources"][number];
  readonly signatureText: string | null;
}

interface MissingJsDoc {
  readonly _tag: "MissingJsDoc";
  readonly folder: string;
}

const makeMissingJsDoc = (folder: string): MissingJsDoc => ({
  _tag: "MissingJsDoc",
  folder,
});

/**
 * Render MODULE.md + Mintlify MDX for every folder whose `index.ts`
 * has a leading file-level JSDoc block. Folders without that block
 * print a warning and are skipped (loud, not silent). After rendering,
 * orphan MDX twins (slugs no longer produced by the generator) and
 * orphan MODULE.md files (folders whose `index.ts` is gone) are
 * deleted so the published docs tree matches the source tree.
 * @param cache Loaded TypeDoc reflection cache.
 * @param config Documentation generation configuration.
 * @returns The generate module docs result.
 */
export const generateModuleDocs = (
  cache: TypeDocCache,
  config: ModuleRenderConfig,
): Effect.Effect<
  readonly ModuleRenderResult[],
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const missingTypeDocPackages = REQUIRED_V2_PACKAGE_NAMES.filter(
      (packageName) => !cache.byPackageEntrypoint.has(packageName),
    );
    if (missingTypeDocPackages.length > 0) {
      return yield* Effect.dieMessage(
        `Required TypeDoc packages were not loaded: ${missingTypeDocPackages.join(", ")}`,
      );
    }
    const missingServerSubpaths = REQUIRED_V2_SERVER_SUBPATHS.filter(
      (importPath) =>
        (cache.byPackageEntrypoint.get(importPath)?.length ?? 0) === 0,
    );
    if (missingServerSubpaths.length > 0) {
      return yield* Effect.dieMessage(
        `Required TypeDoc server subpaths were not loaded: ${missingServerSubpaths.join(", ")}`,
      );
    }
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
      if (result !== null) {
        rendered.push(result);
      }
    }
    if (warnings.length > 0) {
      yield* emitWarnings(warnings);
    }
    const renderedFolders = new Set(rendered.map((result) => result.folder));
    const missingRequiredFolders = REQUIRED_V2_MODULE_FOLDERS.filter(
      (folder) => !renderedFolders.has(folder),
    );
    if (missingRequiredFolders.length > 0) {
      return yield* Effect.dieMessage(
        `Required MODULE documentation was not rendered for: ${missingRequiredFolders.join(", ")}`,
      );
    }
    yield* pruneOrphans(rendered, config, path);
    return rendered;
  }).pipe(Effect.withSpan("generateModuleDocs"));

/**
 * Delete docs/modules MDX files whose slug is not produced by this
 * pass, and delete `MODULE.md` siblings whose folder is no longer in
 * the rendered set. A stale flat-layout `docs/modules/protocol/foo.mdx`
 * left behind by a previous generator shape stays referenced from no
 * `_nav.json` entry and confuses `docs:check:drift`; pruning closes
 * the loop.
 * @param rendered Rendered module documentation.
 * @param config Documentation generation configuration.
 * @param path Path to process.
 * @returns The prune orphans result.
 */
function pruneOrphans(
  rendered: readonly ModuleRenderResult[],
  config: ModuleRenderConfig,
  path: Path.Path,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const liveSlugs = new Set(rendered.map((r) => r.pageSlug));
    const liveFolders = new Set(rendered.map((r) => r.folder));
    const mdxPaths = yield* listFilesWithSuffix(
      fs,
      config.docsModulesDir,
      ".mdx",
    );
    for (const abs of mdxPaths) {
      const rel = path.relative(config.docsModulesDir, abs);
      const slug = rel.replace(/\.mdx$/, "");
      if (liveSlugs.has(slug)) {
        continue;
      }
      yield* fs.remove(abs).pipe(Effect.catchAll(() => Effect.void));
      process.stdout.write(`  pruned orphan MDX: ${rel}\n`);
    }
    const moduleRoots = [
      path.resolve(config.workspaceRoot, "packages"),
      ...REQUIRED_V2_MODULE_FOLDERS.map((folder) =>
        path.resolve(config.workspaceRoot, folder),
      ),
    ];
    const modulePaths = (yield* Effect.all(
      moduleRoots.map((root) => listFilesWithSuffix(fs, root, "MODULE.md")),
    )).flat();
    for (const abs of modulePaths) {
      const folder = path.relative(config.workspaceRoot, path.dirname(abs));
      if (liveFolders.has(folder)) {
        continue;
      }
      yield* fs.remove(abs).pipe(Effect.catchAll(() => Effect.void));
      process.stdout.write(`  pruned orphan MODULE.md: ${folder}\n`);
    }
  });
}

function listFilesWithSuffix(
  fs: FileSystem.FileSystem,
  root: string,
  suffix: string,
): Effect.Effect<readonly string[]> {
  return Effect.gen(function* () {
    const out: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) {
        break;
      }
      const entries = yield* fs
        .readDirectory(dir)
        .pipe(Effect.catchAll(() => Effect.succeed([])));
      for (const name of entries) {
        if (name === "node_modules" || name === "dist") {
          continue;
        }
        const abs = `${dir}/${name}`;
        const stat = yield* fs
          .stat(abs)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (stat === null) {
          continue;
        }
        if (stat.type === "Directory") {
          stack.push(abs);
        } else if (name.endsWith(suffix)) {
          out.push(abs);
        }
      }
    }
    return out;
  });
}

function emitWarnings(folders: readonly string[]): Effect.Effect<void> {
  return Effect.sync(() => {
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
}

function discoverFolders(
  cache: TypeDocCache,
  config: ModuleRenderConfig,
): Effect.Effect<readonly string[], never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const seen = new Set<string>(REQUIRED_V2_MODULE_FOLDERS);
    for (const ex of cache.all) {
      const folder = folderOf(ex);
      if (!isDocumentedSourceFolder(folder)) {
        continue;
      }
      const indexPath = path.resolve(config.workspaceRoot, folder, "index.ts");
      const hasIndex = yield* fs
        .exists(indexPath)
        .pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (!hasIndex) {
        continue;
      }
      const indexSource = yield* fs
        .readFileString(indexPath)
        .pipe(Effect.catchAll(() => Effect.succeed("")));
      if (isInternalModuleSource(indexSource)) {
        continue;
      }
      if (isPackageRoot(folder)) {
        if (
          isEmptyBarrelSource(indexSource) &&
          !isRequiredV2ModuleFolder(folder)
        ) {
          continue;
        }
      }
      seen.add(folder);
    }
    return [...seen].sort((left, right) => left.localeCompare(right));
  });
}

/**
 * A workspace package's `src` folder is its package root. Sub-folders below
 * `src/` keep their own opt-in via the leading-JSDoc gate in `renderFolder`.
 * @param folder Module folder to process.
 * @returns Whether package root.
 */
function isPackageRoot(folder: string): boolean {
  const parts = sourcePathParts(folder);
  return (
    parts.length === 3 &&
    (parts[0] === "packages" || parts[0] === "v2") &&
    parts[2] === "src"
  );
}

function isDocumentedSourceFolder(folder: string): boolean {
  return (
    folder.startsWith("packages/") ||
    REQUIRED_V2_MODULE_FOLDERS.some(
      (root) => folder === root || folder.startsWith(`${root}/`),
    )
  );
}

function isRequiredV2ModuleFolder(folder: string): boolean {
  return REQUIRED_V2_MODULE_FOLDERS.some((required) => required === folder);
}

/**
 * True when `src/index.ts` is intentionally empty (`export {};`) — no
 * value re-exports. Used to skip MODULE/MDX emission for packages whose
 * public surface is the bin, not a programmatic API.
 * @param source Source text to process.
 * @returns Whether empty barrel source.
 */
function isEmptyBarrelSource(source: string): boolean {
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/export\s*\{\s*\}\s*;?/g, "")
    .trim();
  return cleaned.length === 0;
}

function isInternalModuleSource(source: string): boolean {
  const purpose = readLeadingJsDoc(source);
  return purpose !== null && /(^|\s)@internal(\s|$)/.test(purpose);
}

function renderFolder(
  folder: string,
  cache: TypeDocCache,
  config: ModuleRenderConfig,
  path: Path.Path,
): Effect.Effect<ModuleRenderResult, MissingJsDoc, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const indexPath = path.resolve(config.workspaceRoot, folder, "index.ts");
    const indexSource = yield* fs
      .readFileString(indexPath)
      .pipe(Effect.catchAll(() => Effect.succeed("")));
    const purpose = readLeadingJsDoc(indexSource);
    if (purpose === null) {
      return yield* Effect.fail(makeMissingJsDoc(folder));
    }
    const packageRoot = isPackageRoot(folder);
    const packageName = packageRoot
      ? yield* readPackageName(folder, config, fs, path)
      : null;
    const exports = (
      packageName !== null
        ? exportsForPackageRoot(cache, packageName)
        : exportsForModuleFolder(cache, folder)
    ).filter(isBehavioral);
    const enriched = yield* enrichWithSignatures(exports, fs, path, config);
    const subpaths =
      packageName === null
        ? []
        : yield* Effect.forEach(
            serverSubpathsForPackage(cache, packageName),
            (subpath) =>
              enrichWithSignatures(subpath.exports, fs, path, config).pipe(
                Effect.map(
                  (subpathExports): EnrichedSubpath => ({
                    importPath: subpath.importPath,
                    exports: subpathExports,
                  }),
                ),
              ),
            { concurrency: "inherit" },
          );
    const documentedExports = [
      ...enriched,
      ...subpaths.flatMap((subpath) => subpath.exports),
    ];
    const sourceFiles = isRequiredV2ModuleFolder(folder)
      ? yield* collectProductionSourceFiles(folder, config, fs, path)
      : documentedExports.flatMap((entry) =>
          entry.sources.map((source) => source.fileName),
        );
    const pageSlug = modulePageSlug(folder);
    const h1 = `# ${pageSlug}`;
    const moduleMdBody = renderMarkdown({
      h1,
      subtitle: `_\`${folder}\`_`,
      purpose,
      exports: enriched,
      subpaths,
      sourceFiles,
      folder,
      path,
      linkContext: { mode: "module-md" },
    });
    const mdxBody = renderMarkdown({
      h1,
      subtitle: `_\`${folder}\`_`,
      purpose,
      exports: enriched,
      subpaths,
      sourceFiles,
      folder,
      path,
      linkContext: { mode: "mdx" },
    });
    yield* writeAtomic(
      fs,
      path.resolve(config.workspaceRoot, folder, "MODULE.md"),
      moduleMdBody,
    );
    yield* writeAtomic(
      fs,
      path.resolve(config.docsModulesDir, `${pageSlug}.mdx`),
      `${renderFrontmatter({ title: pageSlug, description: firstSentence(purpose) })}\n${mdxBody}`,
    );
    return { folder, h1, pageSlug };
  });
}

function collectProductionSourceFiles(
  folder: string,
  config: ModuleRenderConfig,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<readonly string[]> {
  const sourceRoot = path.resolve(config.workspaceRoot, folder);
  return Effect.all([
    listFilesWithSuffix(fs, sourceRoot, ".ts"),
    listFilesWithSuffix(fs, sourceRoot, "README.md"),
  ]).pipe(
    Effect.map((files) =>
      files
        .flat()
        .map((file) => path.relative(config.workspaceRoot, file))
        .filter(
          (file) =>
            !file.includes("/__tests__/") &&
            !file.endsWith(".test.ts") &&
            !file.endsWith(".integration.test.ts") &&
            !file.endsWith(".types-check.ts"),
        )
        .sort((left, right) => left.localeCompare(right)),
    ),
  );
}

/**
 * A package-root module documents its entry point, so it owns every public
 * symbol TypeDoc associates with that package even when the declaration lives
 * in a nested capability folder. Nested module pages continue to own symbols
 * by declaration folder.
 * @param cache Loaded TypeDoc reflection cache.
 * @param packageName Value supplied to the operation.
 * @returns The exports for package root result.
 */
export function exportsForPackageRoot(
  cache: TypeDocCache,
  packageName: string,
): readonly TypeDocExport[] {
  return cache.byPackageEntrypoint.get(packageName) ?? [];
}

/**
 * Returns the documented server subpath exported by one active v2 package.
 *
 * @param cache Loaded TypeDoc reflection cache.
 * @param packageName Package whose approved server entrypoint is requested.
 * @returns The package's server import path and exported namespace members.
 */
function serverSubpathsForPackage(
  cache: TypeDocCache,
  packageName: string,
): ReadonlyArray<
  Readonly<{
    importPath: string;
    exports: readonly TypeDocExport[];
  }>
> {
  const importPath = `${packageName}/server`;
  if (
    !REQUIRED_V2_SERVER_SUBPATHS.some(
      (requiredImportPath) => requiredImportPath === importPath,
    )
  ) {
    return [];
  }
  return [
    {
      importPath,
      exports: cache.byPackageEntrypoint.get(importPath) ?? [],
    },
  ];
}

/**
 * Executes the exports for module folder operation.
 * @param cache Loaded TypeDoc reflection cache.
 * @param folder Module folder to process.
 * @returns The exports for module folder result.
 */
export function exportsForModuleFolder(
  cache: TypeDocCache,
  folder: string,
): readonly TypeDocExport[] {
  return cache.byFolder.get(folder) ?? [];
}

const packageManifest = Schema.parseJson(
  Schema.Struct({ name: Schema.NonEmptyString }),
);

function readPackageName(
  folder: string,
  config: ModuleRenderConfig,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<string> {
  return fs
    .readFileString(
      path.resolve(config.workspaceRoot, folder, "..", "package.json"),
    )
    .pipe(
      Effect.flatMap(Schema.decodeUnknown(packageManifest)),
      Effect.map((manifest) => manifest.name),
      Effect.orDie,
    );
}

function enrichWithSignatures(
  exports: readonly TypeDocExport[],
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: ModuleRenderConfig,
): Effect.Effect<readonly EnrichedExport[]> {
  return Effect.gen(function* () {
    const fileCache = new Map<string, string>();
    const parsedFileCache = new Map<string, ts.SourceFile>();
    const enriched: EnrichedExport[] = [];
    for (const ex of exports) {
      if (
        ex.kind === ReflectionKind.Module ||
        ex.kind === ReflectionKind.Namespace
      ) {
        enriched.push({ ...ex, signatureText: null });
        continue;
      }
      for (const sourceLocation of ex.sources) {
        if (fileCache.has(sourceLocation.fileName)) {
          continue;
        }
        const abs = path.resolve(config.workspaceRoot, sourceLocation.fileName);
        const source = yield* fs
          .readFileString(abs)
          .pipe(Effect.catchAll(() => Effect.succeed("")));
        fileCache.set(sourceLocation.fileName, source);
      }
      const resolved = resolveExportDeclarationWithCache(
        ex,
        fileCache,
        parsedFileCache,
      );
      if (resolved.source === undefined) {
        enriched.push({ ...ex, signatureText: null });
        continue;
      }
      enriched.push({
        ...ex,
        sources: [
          resolved.source,
          ...ex.sources.filter((source) => source !== resolved.source),
        ],
        signatureText: resolved.signatureText,
      });
    }
    return enriched;
  });
}

/**
 * Resolve the declaration represented by one TypeDoc reflection.
 *
 * TypeDoc reports every source in a declaration-merged symbol, so the first
 * location can belong to a different reflection kind. TypeScript identifies
 * the declaration whose name and syntax kind match the reflection.
 *
 * @param ex TypeDoc export to resolve.
 * @param sourceByFile Source text keyed by workspace-relative file name.
 * @returns The matching source location and extracted declaration.
 */
export function resolveExportDeclaration(
  ex: TypeDocExport,
  sourceByFile: ReadonlyMap<string, string>,
): ResolvedExportDeclaration {
  return resolveExportDeclarationWithCache(ex, sourceByFile, new Map());
}

function resolveExportDeclarationWithCache(
  ex: TypeDocExport,
  sourceByFile: ReadonlyMap<string, string>,
  parsedFileCache: Map<string, ts.SourceFile>,
): ResolvedExportDeclaration {
  const source =
    ex.sources.length > 1
      ? ex.sources.find((candidate) =>
          sourceMatchesExport(candidate, ex, sourceByFile, parsedFileCache),
        )
      : ex.sources[0];
  const fallbackSource = source ?? ex.sources[0];
  if (fallbackSource === undefined) {
    return { signatureText: null };
  }
  const text = sourceByFile.get(fallbackSource.fileName) ?? "";
  return {
    source: fallbackSource,
    signatureText: extractSignatureText(
      text,
      fallbackSource.line,
      ex.kind,
      fallbackSource.fileName.startsWith("v2/"),
    ),
  };
}

const REFLECTION_KIND_BY_DECLARATION_SYNTAX = new Map<ts.SyntaxKind, number>([
  [ts.SyntaxKind.VariableDeclaration, ReflectionKind.Variable],
  [ts.SyntaxKind.TypeAliasDeclaration, ReflectionKind.TypeAlias],
  [ts.SyntaxKind.InterfaceDeclaration, ReflectionKind.Interface],
  [ts.SyntaxKind.ClassDeclaration, ReflectionKind.Class],
  [ts.SyntaxKind.FunctionDeclaration, ReflectionKind.Function],
  [ts.SyntaxKind.EnumDeclaration, ReflectionKind.Enum],
  [ts.SyntaxKind.ModuleDeclaration, ReflectionKind.Module],
]);

function sourceMatchesExport(
  source: TypeDocExport["sources"][number],
  ex: TypeDocExport,
  sourceByFile: ReadonlyMap<string, string>,
  parsedFileCache: Map<string, ts.SourceFile>,
): boolean {
  const text = sourceByFile.get(source.fileName);
  if (text === undefined) {
    return false;
  }
  let sourceFile = parsedFileCache.get(source.fileName);
  if (sourceFile === undefined) {
    sourceFile = ts.createSourceFile(
      source.fileName,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    parsedFileCache.set(source.fileName, sourceFile);
  }

  const lineStart = sourceFile.getLineStarts()[source.line - 1];
  if (lineStart === undefined) {
    return false;
  }
  const position = lineStart + source.character;
  if (position < lineStart || position >= sourceFile.end) {
    return false;
  }
  const name = deepestNodeAtPosition(sourceFile, sourceFile, position);
  return (
    name.getStart(sourceFile) === position &&
    (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
    name.text === ex.name &&
    REFLECTION_KIND_BY_DECLARATION_SYNTAX.get(name.parent.kind) === ex.kind
  );
}

function deepestNodeAtPosition(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  position: number,
): ts.Node {
  const child = node
    .getChildren(sourceFile)
    .find(
      (candidate) =>
        candidate.getStart(sourceFile) <= position &&
        position < candidate.getEnd(),
    );
  return child === undefined
    ? node
    : deepestNodeAtPosition(sourceFile, child, position);
}

function writeAtomic(
  fs: FileSystem.FileSystem,
  absolutePath: string,
  content: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
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
}

interface RenderArgs {
  readonly h1: string;
  readonly subtitle: string;
  readonly purpose: string;
  readonly exports: readonly EnrichedExport[];
  readonly subpaths: readonly EnrichedSubpath[];
  readonly sourceFiles: readonly string[];
  readonly folder: string;
  readonly path: Path.Path;
  readonly linkContext: LinkContext;
}

function renderMarkdown(args: RenderArgs): string {
  const sorted = [...args.exports].sort((a, b) => a.name.localeCompare(b.name));
  const sections: string[][] = [
    renderHeader(args),
    renderPublicSurface(sorted, args.folder, args.path, args.linkContext),
    renderServerSubpaths(
      args.subpaths,
      args.folder,
      args.path,
      args.linkContext,
    ),
    renderFilesSection(args.sourceFiles, args.folder, args.path),
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
  sorted: readonly EnrichedExport[],
  folder: string,
  path: Path.Path,
  link: LinkContext,
): string[] {
  const lines: string[] = ["## Public surface", ""];
  if (sorted.length === 0) {
    lines.push("_No exports surfaced from this folder._", "");
    return lines;
  }
  const nameCounts = new Map<string, number>();
  for (const entry of sorted) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  for (const ex of sorted) {
    const displayName =
      isRequiredV2ModuleFolder(folder) && (nameCounts.get(ex.name) ?? 0) > 1
        ? `${ex.name} (${declarationRole(ex)})`
        : ex.name;
    lines.push(
      ...renderExport(ex, folder, path, {
        ...link,
        displayName,
      }),
    );
  }
  return lines;
}

function declarationRole(ex: EnrichedExport): string {
  if (
    ex.kind === ReflectionKind.TypeAlias ||
    ex.kind === ReflectionKind.Interface
  ) {
    return "type";
  }
  if (
    ex.kind === ReflectionKind.Variable ||
    ex.kind === ReflectionKind.Function
  ) {
    return "value";
  }
  return ex.kindString.toLowerCase();
}

function renderServerSubpaths(
  subpaths: readonly EnrichedSubpath[],
  folder: string,
  path: Path.Path,
  link: LinkContext,
): string[] {
  if (subpaths.length === 0) {
    return [];
  }
  const lines: string[] = ["## Server subpath", ""];
  for (const subpath of subpaths) {
    lines.push(`### \`${subpath.importPath}\``, "");
    const namespaceName = subpath.exports.find(
      (entry) =>
        entry.kind === ReflectionKind.Module ||
        entry.kind === ReflectionKind.Namespace,
    )?.name;
    for (const entry of subpath.exports) {
      const displayName =
        namespaceName === undefined || entry.name === namespaceName
          ? entry.name
          : `${namespaceName}.${entry.name}`;
      lines.push(
        ...renderExport(entry, folder, path, {
          ...link,
          displayName,
          headingLevel: 4,
        }),
      );
    }
  }
  return lines;
}

/**
 * Escape MDX-significant characters in JSDoc prose. MDX parses a bare open-angle
 * as a JSX tag and a bare open-brace as an expression, so an un-fenced
 * `Schema&lt;T>` or `{ onExcessProperty }` in a summary is a parse error on the
 * Mintlify page. Escape both to their HTML entities — but only OUTSIDE
 * inline-code backtick spans, where MDX already treats the content literally.
 * The MODULE.md twin (GitHub-rendered Markdown) needs no escaping, so this runs
 * only in `mdx` mode.
 * @param text Text to process.
 * @returns The escape mdx prose result.
 */
function escapeMdxProse(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        return line;
      }
      // Inside a fenced block, or an indented (4-space) code block, MDX already
      // treats the content literally — leave it untouched.
      if (inFence || /^ {4,}/.test(line)) {
        return line;
      }
      // Prose line: escape `<`/`{` outside inline-code backtick spans.
      return line
        .split(/(`[^`]*`)/)
        .map((segment, i) =>
          i % 2 === 1
            ? segment
            : segment.replaceAll("<", "&lt;").replaceAll("{", "&#123;"),
        )
        .join("");
    })
    .join("\n");
}

function renderExport(
  ex: EnrichedExport,
  folder: string,
  path: Path.Path,
  link: LinkContext,
): string[] {
  const prose = (text: string) =>
    link.mode === "mdx" ? escapeMdxProse(text) : text;
  const heading = "#".repeat(link.headingLevel ?? 3);
  const lines: string[] = [
    `${heading} ${exportLink(ex, folder, path, link)}`,
    "",
    `_${ex.kindString}_`,
    "",
  ];
  if (ex.signatureText) {
    lines.push("```ts", ex.signatureText, "```", "");
  }
  const summary = ex.comment?.summary.trim();
  if (summary && summary.length > 0) {
    lines.push(prose(summary), "");
  }
  lines.push(...renderFailures(ex));
  const returns = ex.comment?.tags.find((t) => t.tag === "@returns")?.content;
  if (returns) {
    lines.push(`**Returns:** ${prose(returns)}`, "");
  }
  return lines;
}

function exportLink(
  ex: EnrichedExport,
  folder: string,
  path: Path.Path,
  link: LinkContext,
): string {
  const displayName = link.displayName ?? ex.name;
  const src = ex.sources[0];
  if (!src) {
    return `\`${displayName}\``;
  }
  if (link.mode === "module-md") {
    return `[\`${displayName}\`](./${path.relative(folder, src.fileName)}#L${src.line})`;
  }
  // MDX twin lives outside the source tree; emit a GitHub permalink so
  // the rendered Mintlify page resolves to a real source location.
  return `[\`${displayName}\`](${sourcePermalink(src.fileName, src.line)})`;
}

function renderFailures(ex: EnrichedExport): string[] {
  const failures = ex.comment?.tags.filter((t) => t.tag === "@failure") ?? [];
  if (failures.length === 0) {
    return [];
  }
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
  sourceFiles: readonly string[],
  folder: string,
  path: Path.Path,
): string[] {
  const lines: string[] = ["## Files", ""];
  const files = [...new Set(sourceFiles)]
    .filter((f) => f.startsWith(`${folder}/`))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    lines.push("_No source files tracked under this folder by TypeDoc._");
  } else {
    for (const f of files) {
      const displayPath = isRequiredV2ModuleFolder(folder)
        ? path.relative(folder, f)
        : path.basename(f);
      lines.push(`- \`${displayPath}\``);
    }
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
 * @param source Source text to process.
 * @returns The read leading js doc result.
 */
export function readLeadingJsDoc(source: string): string | null {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith("/**")) {
    return null;
  }
  const closeIx = trimmed.indexOf("*/");
  if (closeIx === -1) {
    return null;
  }
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
 * @param text Text to process.
 * @returns The decoded failure tag.
 */
export function parseFailureTag(text: string): {
  readonly errorName: string;
  readonly when: string | null;
} {
  const t = text.trim();
  const ix = t.indexOf(" when ");
  if (ix === -1) {
    const space = t.indexOf(" ");
    if (space === -1) {
      return { errorName: t, when: null };
    }
    return { errorName: t.slice(0, space), when: t.slice(space + 1).trim() };
  }
  return { errorName: t.slice(0, ix).trim(), when: t.slice(ix + 6).trim() };
}

/**
 * Return the collision-free generated page slug for a module folder.
 * @param folder Workspace-relative module folder.
 * @returns Generated page slug.
 */
export function modulePageSlug(folder: string): string {
  const parts = sourcePathParts(folder);
  const pkg = packageSlugFor(parts);
  const modulePath = pathFromPackageSrc(parts);
  const page = modulePath.length > 0 ? modulePath : (parts.at(-1) ?? "unknown");
  return `${pkg}/${page}`;
}

function packageSlugFor(parts: readonly string[]): string {
  if (parts.length < 2 || (parts[0] !== "packages" && parts[0] !== "v2")) {
    return "unknown";
  }
  const pkg = parts[1];
  if (parts[0] === "v2") {
    return `v2/${pkg ?? "unknown"}`;
  }
  if (pkg === "server") {
    return "server-core";
  }
  return pkg ?? "unknown";
}

function pathFromPackageSrc(parts: readonly string[]): string {
  const srcIx = parts.indexOf("src");
  if (srcIx === -1) {
    return "";
  }
  return parts.slice(srcIx + 1).join("/");
}

function sourcePathParts(folder: string): readonly string[] {
  return folder.split("/");
}

/**
 * Build a source permalink on the branch that owns the source track.
 * @param fileName Workspace-relative source file.
 * @param line One-based source line.
 * @returns GitHub source permalink.
 */
export function sourcePermalink(fileName: string, line: number): string {
  const branch = fileName.startsWith("v2/") ? "v2" : "main";
  return `${SOURCE_LINK_BASE}/${branch}/${fileName}#L${line}`;
}

function isBehavioral(ex: TypeDocExport): boolean {
  if (ex.kind === ReflectionKind.Module) {
    return false;
  }
  if (ex.kind === ReflectionKind.Reference) {
    return false;
  }
  // Drop dunder / canary symbols (e.g. `_TypedDispatcherCanarySink`,
  // `_D1NegativeCanary`) — they live in `*.types-check.ts` files as
  // compile-time gates, not intentional exports.
  if (ex.name.startsWith("_")) {
    return false;
  }
  if (ex.comment?.tags.some((tag) => tag.tag === "@internal")) {
    return false;
  }
  return true;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const m = /^(.+?[.!?])(\s|$)/s.exec(trimmed);
  return m?.[1]?.trim() ?? trimmed.split("\n")[0]?.trim() ?? "";
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
 * @param source Source text to process.
 * @param oneBasedLine Value supplied to the operation.
 * @param kind Value supplied to the operation.
 * @param completeTypeAlias Whether a multiline alias must run through its
 * top-level semicolon.
 * @returns The extract signature text result.
 */
export function extractSignatureText(
  source: string,
  oneBasedLine: number,
  kind: number,
  completeTypeAlias = false,
): string | null {
  if (source.length === 0) {
    return null;
  }
  const lines = source.split("\n");
  if (oneBasedLine < 1 || oneBasedLine > lines.length) {
    return null;
  }
  const startIx = skipLeadingJsDoc(lines, oneBasedLine - 1);
  if (kind === ReflectionKind.TypeAlias && completeTypeAlias) {
    return extractTypeAlias(lines, startIx);
  }
  if (KEEP_BODY_KINDS.has(kind)) {
    return extractBalancedBody(lines, startIx);
  }
  if (FUNCTION_KINDS.has(kind)) {
    return extractFunctionSignature(lines, startIx);
  }
  return extractBalancedBody(lines, startIx);
}

/**
 * TypeDoc reports the source line of the leading JSDoc block as the
 * declaration's source. Skip past the closing `*​/` so signature
 * extraction starts at the actual code.
 * @param lines Value supplied to the operation.
 * @param startIx Value supplied to the operation.
 * @returns The skip leading js doc result.
 */
function skipLeadingJsDoc(lines: readonly string[], startIx: number): number {
  const first = lines[startIx]?.trimStart() ?? "";
  if (!first.startsWith("/**")) {
    return startIx;
  }
  for (let i = startIx; i < lines.length && i < startIx + 200; i++) {
    if ((lines[i] ?? "").includes("*/")) {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "").trim().length === 0) {
        j++;
      }
      return j;
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
 * @param lines Source lines containing the declaration.
 * @param startIx Zero-based declaration start.
 * @returns The complete type alias text.
 */
function extractTypeAlias(lines: readonly string[], startIx: number): string {
  const slice = lines.slice(startIx, Math.min(lines.length, startIx + 120));
  const text = slice.join("\n");
  let depth = 0;
  let semiIx = -1;
  scanTopLevel(text, (ch, i) => {
    if (ch === "(" || ch === "[" || ch === "<" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === ">" || ch === "}") {
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
 * @param lines Value supplied to the operation.
 * @param startIx Value supplied to the operation.
 * @returns The extract balanced body result.
 */
function extractBalancedBody(
  lines: readonly string[],
  startIx: number,
): string {
  const slice = lines.slice(startIx, Math.min(lines.length, startIx + 120));
  const text = slice.join("\n");
  let depth = 0;
  let opened = false;
  let returnIx = -1;
  let semiIx = -1;
  scanTopLevel(text, (ch, i) => {
    if (ch === "(" || ch === "[" || ch === "<" || ch === "{") {
      depth++;
      opened = true;
    } else if (ch === ")" || ch === "]" || ch === ">" || ch === "}") {
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
 * @param text Text to process.
 * @param needles Value supplied to the operation.
 * @returns The pick first cut result.
 */
function pickFirstCut(text: string, needles: readonly string[]): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  let braceDepth = 0;
  return scanTopLevel(text, (ch, i) => {
    const atTopLevel =
      parenDepth === 0 &&
      bracketDepth === 0 &&
      angleDepth === 0 &&
      braceDepth === 0;
    if (atTopLevel) {
      for (const needle of needles) {
        if (text.startsWith(needle, i)) {
          return "stop";
        }
      }
    }
    if (ch === "(") {
      parenDepth++;
    } else if (ch === ")") {
      parenDepth--;
    } else if (ch === "[") {
      bracketDepth++;
    } else if (ch === "]") {
      bracketDepth--;
    } else if (ch === "<") {
      angleDepth++;
    } else if (ch === ">") {
      angleDepth--;
    } else if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      braceDepth--;
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
 * @param text Text to process.
 * @param cb Value supplied to the operation.
 * @returns The scan top level result.
 */
function scanTopLevel(
  text: string,
  cb: (ch: string, ix: number) => "stop" | "continue",
): number {
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && text[i + 1] === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (ch === "\\" && (inSingle || inDouble || inBacktick)) {
      i++;
      continue;
    }
    if (!inDouble && !inBacktick && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inBacktick && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === "`") {
      inBacktick = !inBacktick;
      continue;
    }
    if (inSingle || inDouble || inBacktick) {
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if ((ch === ">" || ch === "<" || ch === "!") && text[i + 1] === "=") {
      i++;
      continue;
    }
    if (ch === "=" && text[i + 1] === "=") {
      i++;
      continue;
    }
    if (cb(ch, i) === "stop") {
      return i;
    }
    if (ch === "=" && text[i + 1] === ">") {
      i++;
    }
  }
  return -1;
}

/* eslint-enable sonarjs/null-dereference -- Limit the generator-specific suppression to this module. */
