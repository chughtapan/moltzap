/**
 * @file Typed read accessors over a TypeDoc JSON dump.
 *
 * The dump at `node_modules/.cache/typedoc.json` is produced once per
 * `pnpm docs:generate` run by invoking TypeDoc with `entryPointStrategy:
 * "packages"`. Renderers consume this loader to look up JSDoc, sources,
 * and signatures by package, by folder, or by name. The loader returns
 * an `Effect` so callers compose with the rest of the Effect-based
 * pipeline.
 */
import { FileSystem, type PlatformError } from "@effect/platform";
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
  readonly byFolder: ReadonlyMap<string, readonly TypeDocExport[]>;
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
 * @returns The load type doc result.
 */
export const loadTypeDoc = (
  cachePath: string,
): Effect.Effect<
  TypeDocCache,
  | TypeDocCacheMissingError
  | TypeDocCacheMalformedError
  | PlatformError.PlatformError,
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
      try: () => JSON.parse(text) as RawReflection,
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

function normalizeSourcePath(p: string, url?: string): string {
  // TypeDoc sometimes emits absolute paths via workspace symlinks —
  // trim anything above `packages/` for workspace-relative output.
  const ix = p.indexOf("packages/");
  if (ix !== -1) {
    return p.slice(ix);
  }
  // Some packages surface a bare package-relative `fileName` (e.g.
  // `entry.ts` instead of `packages/foo/src/entry.ts`). Reconstruct
  // from the source URL, which carries the full repo-relative path
  // after the SHA. Without this, `discoverFolders` skips the export
  // on the `packages/`-prefix check and the package is silently
  // dropped from generated MODULE docs.
  if (url) {
    const m = /\/blob\/[^/]+\/(packages\/[^#?]+)/.exec(url);
    if (m?.[1]) {
      return m[1];
    }
  }
  return p;
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
