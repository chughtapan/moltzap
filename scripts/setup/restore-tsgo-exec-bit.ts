/**
 * @file Restores the exec bit on the `@effect/tsgo-PLATFORM` binaries.
 *
 * Those tarballs publish `lib/tsc` and `lib/tsc-next` with mode 0644, so
 * spawning them fails with EACCES and every `lint:effect` target dies before
 * it type-checks anything. `prepare` runs this after each install. It is
 * idempotent, and a no-op when no platform package is present. A repair
 * failure costs `lint:effect`, not the install, so it warns and exits clean
 * rather than bricking `pnpm install`.
 */
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..", "..");
const EXECUTE_BITS = 0o111;
/** Named exactly, so a future file dropped into `lib/` never inherits +x. */
const BINARY_NAMES: ReadonlySet<string> = new Set(["tsc", "tsc-next"]);

try {
  const repaired = platformPackageDirs().flatMap((dir) => repairPackage(dir));
  if (repaired.length > 0) {
    console.log(
      `[restore-tsgo-exec-bit] made executable:\n  ${repaired.join("\n  ")}`,
    );
  }
} catch (cause) {
  console.warn(`[restore-tsgo-exec-bit] skipped: ${String(cause)}`);
}

/**
 * Collect every `@effect/tsgo-*` package directory, whether hoisted into
 * `node_modules/@effect` or isolated in pnpm's content-addressed store.
 * @returns Absolute paths to the platform package roots.
 */
function platformPackageDirs(): readonly string[] {
  const pnpmStore = join(workspaceRoot, "node_modules", ".pnpm");
  const storeScopes = existsSync(pnpmStore)
    ? readdirSync(pnpmStore)
        .filter((entry) => entry.startsWith("@effect+tsgo-"))
        .map((entry) => join(pnpmStore, entry, "node_modules", "@effect"))
    : [];
  return [join(workspaceRoot, "node_modules", "@effect"), ...storeScopes]
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((entry) => entry.startsWith("tsgo-"))
        .map((entry) => join(dir, entry)),
    );
}

/**
 * Make the named binaries in one platform package executable.
 * @param packageDir Platform package root.
 * @returns Workspace-relative paths of the binaries this call repaired.
 */
function repairPackage(packageDir: string): readonly string[] {
  const libDir = join(packageDir, "lib");
  if (!existsSync(libDir)) {
    return [];
  }
  return readdirSync(libDir)
    .filter((entry) => BINARY_NAMES.has(entry))
    .map((entry) => join(libDir, entry))
    .filter((binary) => repairBinary(binary))
    .map((binary) => binary.slice(workspaceRoot.length + 1));
}

/**
 * Add the exec bits to one regular file. `lstat` rather than `stat`: a
 * symlink under `lib/` is skipped, not dereferenced, so a corrupted
 * dependency tree cannot redirect the chmod at an arbitrary target.
 * @param binary Absolute path of the candidate binary.
 * @returns Whether the mode changed.
 */
function repairBinary(binary: string): boolean {
  const stats = lstatSync(binary);
  if (!stats.isFile() || (stats.mode & EXECUTE_BITS) === EXECUTE_BITS) {
    return false;
  }
  chmodSync(binary, stats.mode | EXECUTE_BITS);
  return true;
}
