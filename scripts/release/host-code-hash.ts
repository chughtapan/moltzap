#!/usr/bin/env node
/**
 * @file Hash of the code a host process loads for one plugin package.
 *
 * Usage: `node scripts/release/host-code-hash.ts DIR`, where DIR names a
 * directory under `packages/`. Prints `sha256:` and a hex digest.
 *
 * The release records this value in the OpenClaw channel's published
 * manifest as `sharnessHostCodeHash`. OpenClaw loads the channel and every
 * module the channel's JavaScript reaches, including modules of the
 * `@moltzap/*` siblings it imports, and nothing else of those siblings: the
 * channel imports only the Client root entry, never `./service` or the
 * `sharnessd` binary. A launcher compares two versions' values and restarts
 * OpenClaw only when they differ. The hash therefore covers every packed
 * file of the plugin package, plus each sibling module reachable from it by
 * static or dynamic import through the sibling's `exports` map. Manifests
 * hash without `version`, the recorded hashes, and `@moltzap/*` dependency
 * entries, so a sibling version bump with identical reachable code leaves it
 * unchanged.
 *
 * Run from the repository root after `pnpm build`. Exits 1 when packing or
 * extracting fails.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { FINAL_PACKAGE_DIRS } from "../architecture/boundary-contract.ts";
import {
  digestOf,
  fileEntry,
  packedFiles,
  type PackFailure,
  packInto,
  withScratch,
} from "./content-hash.ts";

/** One file of one package in the module graph. */
interface Module {
  readonly name: string;
  readonly relative: string;
}

/**
 * Pack `packages/DIR` and its `@moltzap/*` closure and hash the code a host
 * loads for it.
 * @param repo Repository root.
 * @param dir Directory name under `packages/`.
 * @returns The host-code hash, or the step that failed.
 */
export function hostCodeHashOfPackage(
  repo: string,
  dir: string,
): string | PackFailure {
  const directories = workspaceDirectories(repo);
  const host = manifestName(repo, dir);
  return withScratch((scratch) => {
    const roots = new Map<string, string>();
    for (const name of siblingClosure(repo, host, directories)) {
      const sibling = directories.get(name) ?? dir;
      const root = packInto(repo, sibling, scratch);
      if (typeof root !== "string") {
        return root;
      }
      roots.set(name, root);
    }
    return hostCodeHashOfDirectories(host, roots);
  });
}

/**
 * Hash the host package's files and every sibling module they reach.
 * @param host The plugin package's npm name.
 * @param roots Extracted `package/` directory of the host and each sibling.
 * @returns `sha256:` and the hex digest.
 */
export function hostCodeHashOfDirectories(
  host: string,
  roots: ReadonlyMap<string, string>,
): string {
  const hostRoot = roots.get(host) ?? "";
  const pending: Module[] = packedFiles(hostRoot).map((relative) => ({
    name: host,
    relative,
  }));
  return digestOf(
    reachableModules(pending, roots).map(({ name, relative }) =>
      fileEntry(roots.get(name) ?? "", relative, `${name}/${relative}`, {
        siblingPins: "drop",
      }),
    ),
  );
}

/**
 * Modules reachable from a package's production root export, including its
 * manifest. The release hash follows the same production export conditions.
 * @param root Package directory containing its manifest and built exports.
 * @returns Package-relative files loaded by the root entry.
 */
export function hostModulesOfDirectory(root: string): ReadonlySet<string> {
  const name = "host";
  const entry = exportTarget(root, ".");
  if (entry === undefined) {
    return new Set();
  }
  return new Set(
    reachableModules(
      [
        { name, relative: path.posix.normalize(entry) },
        { name, relative: "package.json" },
      ],
      new Map([[name, root]]),
    ).map(({ relative }) => relative),
  );
}

function reachableModules(
  entries: readonly Module[],
  roots: ReadonlyMap<string, string>,
): readonly Module[] {
  const pending = [...entries];
  const seen = new Set<string>();
  const modules: Module[] = [];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const root = roots.get(next.name) ?? "";
    const label = `${next.name}/${next.relative}`;
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    modules.push(next);
    pending.push(...importedModules(next, root, roots));
  }
  return modules;
}

function workspaceDirectories(repo: string): ReadonlyMap<string, string> {
  return new Map(
    FINAL_PACKAGE_DIRS.map((dir) => [manifestName(repo, dir), dir] as const),
  );
}

function manifestName(repo: string, dir: string): string {
  return String(readManifest(repo, dir)?.name);
}

/** The package and every `@moltzap/*` package its dependencies reach. */
function siblingClosure(
  repo: string,
  name: string,
  directories: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const closure = new Set<string>();
  const pending = [name];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const dir = directories.get(next);
    if (closure.has(next) || dir === undefined) {
      continue;
    }
    closure.add(next);
    const dependencies = readManifest(repo, dir)?.dependencies;
    if (typeof dependencies === "object" && dependencies !== null) {
      pending.push(
        ...Object.keys(dependencies).filter((dependency) =>
          dependency.startsWith("@moltzap/"),
        ),
      );
    }
  }
  return closure;
}

/** The modules a JavaScript file imports that resolve inside `roots`. */
function importedModules(
  module: Module,
  root: string,
  roots: ReadonlyMap<string, string>,
): readonly Module[] {
  if (!/\.[cm]?js$/u.test(module.relative)) {
    return [];
  }
  const source = readFileSync(path.join(root, module.relative), "utf8");
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map(({ fileName }) => resolve(module, fileName, roots))
    .filter(
      (target): target is Module =>
        target !== undefined &&
        existsSync(path.join(roots.get(target.name) ?? "", target.relative)),
    );
}

function resolve(
  from: Module,
  specifier: string,
  roots: ReadonlyMap<string, string>,
): Module | undefined {
  if (specifier.startsWith(".")) {
    return {
      name: from.name,
      relative: path.posix.normalize(
        path.posix.join(path.posix.dirname(from.relative), specifier),
      ),
    };
  }
  const parts = specifier.split("/");
  const name = parts.slice(0, 2).join("/");
  const root = roots.get(name);
  if (root === undefined) {
    return undefined;
  }
  const subpath = parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".";
  const target = exportTarget(root, subpath);
  return target === undefined
    ? undefined
    : { name, relative: path.posix.normalize(target) };
}

/** The `import` target an `exports` entry gives production resolution. */
function exportTarget(root: string, subpath: string): string | undefined {
  const exports: unknown = readJson(path.join(root, "package.json"))?.exports;
  if (typeof exports !== "object" || exports === null) {
    return undefined;
  }
  return importCondition(
    Object.entries(exports).find(([key]) => key === subpath)?.[1],
  );
}

function importCondition(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }
  if (typeof entry !== "object" || entry === null || !("import" in entry)) {
    return undefined;
  }
  return typeof entry.import === "string" ? entry.import : undefined;
}

function readManifest(
  repo: string,
  dir: string,
): Record<string, unknown> | undefined {
  return readJson(path.join(repo, "packages", dir, "package.json"));
}

function readJson(file: string): Record<string, unknown> | undefined {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) {
    console.error("usage: host-code-hash.ts DIR");
    process.exit(2);
  }
  const hash = hostCodeHashOfPackage(process.cwd(), dir);
  if (typeof hash !== "string") {
    console.error(hash.message);
    process.exit(1);
  }
  console.log(hash);
}
