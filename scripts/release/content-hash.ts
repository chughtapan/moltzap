#!/usr/bin/env node
/**
 * @file Content hash of one package as `pnpm pack` would publish it.
 *
 * Usage: `node scripts/release/content-hash.ts DIR`, where DIR names a
 * directory under `packages/`. Prints `sha256:` and a hex digest.
 *
 * The release records this value in each published manifest as
 * `sharnessContentHash`, and compares it with the value the manifest's
 * version recorded on npm to decide whether the package changed. A consumer
 * compares two published versions' values to decide whether their code
 * differs, so the hash covers every packed file and the packed manifest with
 * exactly two fields left out: `version`, which a release changes without
 * changing code, and `sharnessContentHash` itself. The packed manifest carries
 * the exact versions `pnpm pack` pins each workspace sibling to, so a sibling
 * that publishes a new version changes the hash of every package that
 * depends on it.
 *
 * Run from the repository root after `pnpm build`. Exits 1 when packing or
 * extracting fails.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The manifest field the release writes this hash into. */
export const CONTENT_HASH_FIELD = "sharnessContentHash";

/** One failed packing step, with the output of the command that failed. */
export interface PackFailure {
  readonly kind: "pack-failed";
  readonly message: string;
}

/** Manifest fields a release may change without changing what a package is. */
const UNHASHED_FIELDS: ReadonlySet<string> = new Set([
  "version",
  CONTENT_HASH_FIELD,
]);

/**
 * Pack `packages/DIR` as the workspace stands and hash the tarball's
 * contents.
 * @param repo Repository root.
 * @param dir Directory name under `packages/`.
 * @returns The content hash, or the step that failed.
 */
export function contentHashOfPackage(
  repo: string,
  dir: string,
): string | PackFailure {
  const scratch = mkdtempSync(path.join(tmpdir(), "content-hash-"));
  const packed =
    run("pnpm", ["pack", "--pack-destination", scratch], {
      cwd: path.join(repo, "packages", dir),
    }) ?? tarball(scratch);
  const result =
    typeof packed === "string" ? hashTarball(packed, scratch) : packed;
  rmSync(scratch, { recursive: true, force: true });
  return result;
}

/**
 * Hash an extracted package directory: every file path, in byte order, with
 * the SHA-256 of its hashed bytes.
 * @param root The directory `package/` of an extracted tarball.
 * @returns `sha256:` and the hex digest over the directory's files.
 */
export function contentHashOfDirectory(root: string): string {
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .sort(byteOrder);
  const digest = createHash("sha256");
  for (const relative of files) {
    const fileDigest = createHash("sha256")
      .update(hashedBytes(root, relative))
      .digest("hex");
    digest.update(`${relative}\0${fileDigest}\n`);
  }
  return `sha256:${digest.digest("hex")}`;
}

function tarball(directory: string): string | PackFailure {
  const archives = readdirSync(directory).filter((name) =>
    name.endsWith(".tgz"),
  );
  const [archive] = archives;
  if (archive === undefined || archives.length !== 1) {
    return {
      kind: "pack-failed",
      message: `expected one tarball in ${directory}, found ${archives.length}`,
    };
  }
  return path.join(directory, archive);
}

function hashTarball(archive: string, scratch: string): string | PackFailure {
  return (
    run("tar", ["-xzf", archive, "-C", scratch], { cwd: scratch }) ??
    contentHashOfDirectory(path.join(scratch, "package"))
  );
}

/**
 * Runs one command to completion.
 * @returns Nothing on success, otherwise the failure with its output.
 */
function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
): PackFailure | undefined {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
  });
  if (result.status === 0) {
    return undefined;
  }
  return {
    kind: "pack-failed",
    message: `${command} ${args.join(" ")} in ${options.cwd} failed: ${result.stderr || result.stdout || String(result.error)}`,
  };
}

function byteOrder(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * The bytes the hash reads for one packed file: the root manifest without its
 * unhashed fields, every other file as packed.
 */
function hashedBytes(root: string, relative: string): Buffer {
  const bytes = readFileSync(path.join(root, relative));
  if (relative !== "package.json") {
    return bytes;
  }
  const manifest: unknown = JSON.parse(bytes.toString("utf8"));
  if (typeof manifest !== "object" || manifest === null) {
    return bytes;
  }
  return Buffer.from(
    sortedJson(
      Object.fromEntries(
        Object.entries(manifest).filter(([key]) => !UNHASHED_FIELDS.has(key)),
      ),
    ),
  );
}

/** JSON with object keys sorted at every depth, so key order never matters. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(sortedJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value)
      .sort(([left], [right]) => byteOrder(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) {
    console.error("usage: content-hash.ts DIR");
    process.exit(2);
  }
  const hash = contentHashOfPackage(process.cwd(), dir);
  if (typeof hash !== "string") {
    console.error(hash.message);
    process.exit(1);
  }
  console.log(hash);
}
