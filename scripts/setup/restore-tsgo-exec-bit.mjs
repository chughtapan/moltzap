/**
 * The `@effect/tsgo-<platform>` tarballs publish `lib/tsc` and `lib/tsc-next`
 * with mode 0644, so spawning them fails with EACCES and every `lint:effect`
 * target dies before it type-checks anything. Restore the exec bit after each
 * install. Idempotent, and a no-op when no platform package is present.
 */
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..", "..");
const EXECUTE_BITS = 0o111;
// Named exactly, so a future file dropped into `lib/` never inherits +x.
const BINARY_NAMES = new Set(["tsc", "tsc-next"]);

/**
 * Collect every `@effect/tsgo-*` package directory, whether hoisted into
 * `node_modules/@effect` or isolated in pnpm's content-addressed store.
 * @returns Absolute paths to the platform package roots.
 */
function platformPackageDirs() {
  const scopeDirs = [join(workspaceRoot, "node_modules", "@effect")];
  const pnpmStore = join(workspaceRoot, "node_modules", ".pnpm");
  if (existsSync(pnpmStore)) {
    for (const entry of readdirSync(pnpmStore)) {
      if (entry.startsWith("@effect+tsgo-")) {
        scopeDirs.push(join(pnpmStore, entry, "node_modules", "@effect"));
      }
    }
  }
  return scopeDirs
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((entry) => entry.startsWith("tsgo-"))
        .map((entry) => join(dir, entry)),
    );
}

// `lstat` rather than `stat`: a symlink under `lib/` must be skipped, not
// dereferenced, so a corrupted dependency tree cannot redirect the chmod at an
// arbitrary target. Only regular files are eligible.
function repairBinary(binary) {
  const stats = lstatSync(binary);
  if (!stats.isFile() || (stats.mode & EXECUTE_BITS) === EXECUTE_BITS) {
    return false;
  }
  chmodSync(binary, stats.mode | EXECUTE_BITS);
  return true;
}

const repaired = [];
try {
  for (const packageDir of platformPackageDirs()) {
    const libDir = join(packageDir, "lib");
    if (!existsSync(libDir)) {
      continue;
    }
    for (const entry of readdirSync(libDir)) {
      if (!BINARY_NAMES.has(entry)) {
        continue;
      }
      const binary = join(libDir, entry);
      if (repairBinary(binary)) {
        repaired.push(binary.slice(workspaceRoot.length + 1));
      }
    }
  }
} catch (cause) {
  // A repair failure costs `lint:effect`, not the install. Warn and exit clean
  // so `prepare` cannot brick `pnpm install`.
  console.warn(`[restore-tsgo-exec-bit] skipped: ${cause}`);
}

if (repaired.length > 0) {
  console.log(
    `[restore-tsgo-exec-bit] made executable:\n  ${repaired.join("\n  ")}`,
  );
}
