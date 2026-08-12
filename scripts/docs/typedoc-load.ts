/**
 * @file Workspace documentation accessors over a TypeDoc JSON dump.
 *
 * The dump at `node_modules/.cache/typedoc.json` is produced once per
 * `pnpm docs:generate` run by invoking TypeDoc with `entryPointStrategy:
 * "packages"`. Renderers consume this loader to look up JSDoc, sources,
 * and signatures by package, by folder, or by name. The loader returns
 * an `Effect` so callers compose with the rest of the Effect-based
 * pipeline.
 */
import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Data, Effect } from "effect";
import { dirname } from "node:path";
import { ReflectionKind } from "typedoc";

/** Re-export TypeDoc's authoritative reflection kind enum. */
export { ReflectionKind };

interface TypeDocSource {
  readonly fileName: string; // workspace-relative
  readonly line: number;
  readonly character: number;
  readonly url?: string;
}

interface TypeDocComment {
  readonly summary: string;
  readonly remarks?: string;
  readonly tags: ReadonlyArray<{
    readonly tag: string; // includes the leading "@"
    readonly content: string;
  }>;
}

/** Describes type doc export. */
export interface TypeDocExport {
  readonly id: number;
  readonly name: string;
  readonly kind: number;
  readonly kindString: string;
  readonly packageName: string;
  readonly sources: readonly TypeDocSource[];
  readonly comment: TypeDocComment | null;
  readonly signatureReturnTypeName: string | null;
}

/** Describes type doc cache. */
export interface TypeDocCache {
  readonly all: readonly TypeDocExport[];
  readonly byPackage: ReadonlyMap<string, readonly TypeDocExport[]>;
  readonly byPackageEntrypoint: ReadonlyMap<string, readonly TypeDocExport[]>;
  readonly byFolder: ReadonlyMap<string, readonly TypeDocExport[]>;
}

/** Selects package subpaths that the documentation pipeline may publish. */
export interface TypeDocLoadOptions {
  readonly packageSubpaths?: readonly string[];
}

/** Reports type doc cache missing failures. */
export class TypeDocCacheMissingError extends Data.TaggedError(
  "TypeDocCacheMissingError",
)<{ readonly path: string }> {}

/** Reports type doc cache malformed failures. */
export class TypeDocCacheMalformedError extends Data.TaggedError(
  "TypeDocCacheMalformedError",
)<{ readonly path: string; readonly reason: string }> {}

interface RawComment {
  readonly summary?: ReadonlyArray<{
    readonly kind?: string;
    readonly text?: string;
  }>;
  readonly blockTags?: ReadonlyArray<{
    readonly tag?: string;
    readonly content?: ReadonlyArray<{
      readonly kind?: string;
      readonly text?: string;
    }>;
  }>;
}

interface RawTypeRef {
  readonly type?: string;
  readonly name?: string;
  readonly target?: { readonly name?: string };
}

interface RawReflection {
  readonly id?: number;
  readonly name?: string;
  readonly kind?: number;
  readonly variant?: string;
  readonly target?: number;
  readonly children?: readonly RawReflection[];
  readonly signatures?: ReadonlyArray<{
    readonly comment?: RawComment;
    readonly type?: RawTypeRef;
  }>;
  readonly type?: RawTypeRef;
  readonly sources?: ReadonlyArray<{
    readonly fileName?: string;
    readonly line?: number;
    readonly character?: number;
    readonly url?: string;
  }>;
  readonly comment?: RawComment;
}

/**
 * Load the TypeDoc JSON dump from disk and build lookup indices.
 *
 * Fails with `TypeDocCacheMissingError` when the cache file is absent
 * (caller forgot to run TypeDoc first) and
 * `TypeDocCacheMalformedError` when the JSON cannot be parsed.
 * @param cachePath Value supplied to the operation.
 * @param options Package subpaths admitted to the documentation cache.
 * @returns The load type doc result.
 */
export const loadTypeDoc = (
  cachePath: string,
  options: TypeDocLoadOptions = {},
): Effect.Effect<
  TypeDocCache,
  TypeDocCacheMissingError | TypeDocCacheMalformedError | PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(cachePath)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      return yield* Effect.fail(
        new TypeDocCacheMissingError({ path: cachePath }),
      );
    }
    const text = yield* fs.readFileString(cachePath);
    const raw = yield* Effect.try({
      try: () => {
        return /* Safe because TypeDoc generated this cache and all reflection fields are optional. */ JSON.parse(
          text,
        ) as RawReflection;
      },
      catch: (e) =>
        new TypeDocCacheMalformedError({
          path: cachePath,
          reason: `JSON.parse failed: ${String(e)}`,
        }),
    });
    const all = collectExports(raw);
    return {
      all,
      byPackage: indexBy(all, (e) => e.packageName),
      byPackageEntrypoint: collectPackageEntrypointExports(
        raw,
        new Set(options.packageSubpaths ?? []),
      ),
      byFolder: indexBy(all, (e) => folderOf(e)),
    };
  }).pipe(Effect.withSpan("loadTypeDoc"));

/**
 * Workspace-relative folder of an export's primary declaration.
 * Returns empty string for exports without a source location (rare —
 * mostly synthesized re-exports).
 * @param e Value supplied to the operation.
 * @returns The folder of result.
 */
export function folderOf(e: TypeDocExport): string {
  const first = e.sources[0];
  if (!first) {
    return "";
  }
  return dirname(first.fileName);
}

function collectExports(root: RawReflection): readonly TypeDocExport[] {
  const out: TypeDocExport[] = [];
  for (const pkg of root.children ?? []) {
    const packageName = pkg.name ?? "<unknown>";
    walk(pkg, packageName, out);
  }
  return out;
}

/**
 * TypeDoc represents package entrypoints in two shapes. A focused entrypoint
 * contributes declarations directly beneath the package project, while a
 * package with multiple entrypoints contributes one module per entrypoint.
 * Normalize `index` to the package root and retain only package subpaths that
 * the caller identified from the package's public contract. Expanded TypeDoc
 * projects also represent private source files as modules.
 * @param root Value supplied to the operation.
 * @param packageSubpaths Package import paths approved for publication.
 * @returns The collect package entrypoint exports result.
 */
function collectPackageEntrypointExports(
  root: RawReflection,
  packageSubpaths: ReadonlySet<string>,
): ReadonlyMap<string, readonly TypeDocExport[]> {
  const reflectionsById = indexReflectionsById(root);
  const entries = new Map<string, readonly TypeDocExport[]>();
  for (const pkg of root.children ?? []) {
    const packageName = pkg.name ?? "<unknown>";
    const children = pkg.children ?? [];
    const indexModule = children.find(
      (child) => child.kind === ReflectionKind.Module && child.name === "index",
    );
    const owned = indexModule
      ? (indexModule.children ?? [])
      : children.filter((child) => child.kind !== ReflectionKind.Module);
    entries.set(
      packageName,
      collectOwnedExports(owned, packageName, reflectionsById, false),
    );
    for (const entrypoint of children) {
      const importPath = `${packageName}/${entrypoint.name ?? "<unknown>"}`;
      if (
        entrypoint.kind !== ReflectionKind.Module ||
        entrypoint.name === "index" ||
        !packageSubpaths.has(importPath)
      ) {
        continue;
      }
      entries.set(
        importPath,
        collectOwnedExports(
          entrypoint.children ?? [],
          packageName,
          reflectionsById,
          true,
        ),
      );
    }
  }
  return entries;
}

function collectOwnedExports(
  children: readonly RawReflection[],
  packageName: string,
  reflectionsById: ReadonlyMap<number, RawReflection>,
  includeDescendants: boolean,
): readonly TypeDocExport[] {
  return children.flatMap((child) => {
    const declaration = resolveReference(child, reflectionsById);
    if (declaration === null) {
      return [];
    }
    if (!includeDescendants) {
      return shouldEmit(declaration)
        ? [toExport(declaration, packageName)]
        : [];
    }
    const exports: TypeDocExport[] = [];
    walk(declaration, packageName, exports);
    return exports;
  });
}

function indexReflectionsById(
  root: RawReflection,
): ReadonlyMap<number, RawReflection> {
  const reflections = new Map<number, RawReflection>();
  const pending = [root];
  while (pending.length > 0) {
    const reflection = pending.pop();
    if (reflection === undefined) {
      continue;
    }
    if (reflection.id !== undefined) {
      reflections.set(reflection.id, reflection);
    }
    pending.push(...(reflection.children ?? []));
  }
  return reflections;
}

function resolveReference(
  reflection: RawReflection,
  reflectionsById: ReadonlyMap<number, RawReflection>,
): RawReflection | null {
  const visited = new Set<number>();
  let current = reflection;
  while (
    current.kind === ReflectionKind.Reference &&
    current.target !== undefined
  ) {
    if (visited.has(current.target)) {
      return null;
    }
    visited.add(current.target);
    const target = reflectionsById.get(current.target);
    if (target === undefined) {
      return null;
    }
    current = target;
  }
  return current;
}

function walk(
  node: RawReflection,
  packageName: string,
  out: TypeDocExport[],
): void {
  if (shouldEmit(node)) {
    out.push(toExport(node, packageName));
  }
  if (isStructuralLeaf(node)) {
    return;
  }
  for (const child of node.children ?? []) {
    walk(child, packageName, out);
  }
}

function shouldEmit(node: RawReflection): boolean {
  if (!node.name) {
    return false;
  }
  if (!node.sources || node.sources.length === 0) {
    return false;
  }
  if (node.variant === "project") {
    return false;
  }
  if (node.kind === ReflectionKind.Reference) {
    return false;
  }
  return true;
}

const STRUCTURAL_LEAF_KINDS = new Set<number>([
  ReflectionKind.Class,
  ReflectionKind.Interface,
  ReflectionKind.Enum,
  ReflectionKind.TypeLiteral,
]);

function isStructuralLeaf(node: RawReflection): boolean {
  return node.kind !== undefined && STRUCTURAL_LEAF_KINDS.has(node.kind);
}

function toExport(node: RawReflection, packageName: string): TypeDocExport {
  const sources: TypeDocSource[] = (node.sources ?? []).map((s) => ({
    fileName: normalizeSourcePath(s.fileName ?? "", s.url),
    line: s.line ?? 0,
    character: s.character ?? 0,
    url: s.url,
  }));
  return {
    id: node.id ?? -1,
    name: node.name ?? "<unnamed>",
    kind: node.kind ?? -1,
    kindString: kindToString(node.kind ?? -1),
    packageName,
    sources,
    comment: extractComment(node),
    signatureReturnTypeName: extractReturnTypeName(node),
  };
}

function extractReturnTypeName(node: RawReflection): string | null {
  const sigType = node.signatures?.[0]?.type;
  if (sigType?.name) {
    return sigType.name;
  }
  if (node.type?.name) {
    return node.type.name;
  }
  return null;
}

/**
 * Normalize a TypeDoc source path to a workspace source root.
 * @param sourcePath TypeDoc's reported source path.
 * @param sourceUrl Optional source permalink emitted by TypeDoc.
 * @returns A workspace-relative source path when one can be recovered.
 */
function normalizeSourcePath(sourcePath: string, sourceUrl?: string): string {
  const normalizedPath = sourcePath.replaceAll("\\", "/");
  const workspacePath = findWorkspacePath(normalizedPath);
  if (workspacePath !== null) {
    return workspacePath;
  }

  if (sourceUrl !== undefined) {
    const urlMatch = /\/blob\/[^/]+\/([^#?]+)/.exec(sourceUrl);
    if (urlMatch?.[1] !== undefined) {
      const urlWorkspacePath = findWorkspacePath(urlMatch[1]);
      if (urlWorkspacePath !== null) {
        return urlWorkspacePath;
      }
    }
  }
  return normalizedPath;
}

function findWorkspacePath(sourcePath: string): string | null {
  const match = /(?:^|\/)((?:packages|v2)\/[^/]+\/src(?:\/.*)?$)/.exec(
    sourcePath,
  );
  return match?.[1] ?? null;
}

function extractComment(node: RawReflection): TypeDocComment | null {
  // Functions/Methods carry JSDoc on the first call-signature.
  const c = node.signatures?.[0]?.comment ?? node.comment;
  if (!c) {
    return null;
  }
  const summary = joinParts(c.summary);
  const tags = (c.blockTags ?? []).map(toTag);
  if (summary === "" && tags.length === 0) {
    return null;
  }
  const remarks = tags.find((t) => t.tag === "@remarks")?.content;
  return { summary, remarks, tags };
}

function joinParts(parts?: ReadonlyArray<{ readonly text?: string }>): string {
  return (parts ?? []).map(renderInline).join("").trim();
}

function toTag(t: {
  readonly tag?: string;
  readonly content?: ReadonlyArray<{ readonly text?: string }>;
}): { readonly tag: string; readonly content: string } {
  return { tag: t.tag ?? "", content: joinParts(t.content) };
}

function renderInline(part: {
  readonly kind?: string;
  readonly text?: string;
}): string {
  return part.text ?? "";
}

function kindToString(kind: number): string {
  if (kind in ReflectionKind) {
    const name = ReflectionKind[kind];
    if (typeof name === "string") {
      return name;
    }
  }
  return `Unknown(${kind})`;
}

function indexBy<T, K>(
  items: readonly T[],
  key: (item: T) => K,
): ReadonlyMap<K, readonly T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}
