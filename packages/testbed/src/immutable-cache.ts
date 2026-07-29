import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Effect, Option } from "effect";
import { makeCommandHelpers } from "./child-process.js";

// Install caches and runtime dirs can become Docker bind-mount sources. Keeping
// the shared root under home makes those paths visible to VM-backed engines.
export const MOLTZAP_TESTBED_CACHE_ROOT = join(
  homedir(),
  ".cache",
  "moltzap-testbed",
);

const BUILDING_CACHE_PREFIX = ".building-";
const CACHE_GENERATION_PREFIX = "generation-";
const READY_MARKER = ".ready";
const STALE_BUILDING_CACHE_MAX_AGE_MS = 86_400_000;

// Cold builds download, compile, and image-build multi-minute artifacts, so
// every cache in this process takes turns rather than multiplying that cost
// across concurrent agent spawns.
export const CACHE_BUILD_PERMIT = Effect.runSync(Effect.makeSemaphore(1));

type ErrorFactory<E> = (reason: string, cause?: unknown) => E;

// The cache's own filesystem-error mapper: bound once per cache so each
// operation reports failures in its owner's error channel.
type FsEffect<E> = <A, R>(
  reason: string,
  effect: Effect.Effect<A, PlatformError, R>,
) => Effect.Effect<A, E, R>;

/**
 * Hashes one cache's field list into the key naming its generations. Callers
 * own every field, including host identity, so their tests can vary it.
 */
export function cacheFingerprint(
  schemaVersion: number,
  payload: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ cacheSchema: schemaVersion, ...payload }))
    .digest("hex");
}

/**
 * Binds the filesystem lifecycle shared by immutable install caches to one
 * cache root. Each owner supplies its typed error factory while cleanup and
 * stale-cache sweeping remain best-effort operations.
 */
export function makeImmutableCache<E>(
  cacheRoot: string,
  makeError: ErrorFactory<E>,
) {
  const { fsEffect } = makeCommandHelpers(makeError);
  return {
    createBuildingCache: () => createBuildingCache(cacheRoot, fsEffect),
    findCacheGeneration: (fingerprint: string) =>
      findCacheGeneration(cacheRoot, fingerprint, fsEffect),
    publishCacheGeneration: (buildingDir: string) =>
      publishCacheGeneration(cacheRoot, buildingDir, fsEffect),
    removeBuildingCacheBestEffort,
    sweepStaleBuildingCaches: (
      maxAgeMs: number = STALE_BUILDING_CACHE_MAX_AGE_MS,
    ) => sweepStaleBuildingCaches(cacheRoot, maxAgeMs),
    writeReadyMarker: (cacheDir: string, fingerprint: string) =>
      writeReadyMarker(cacheDir, fingerprint, fsEffect),
  };
}

function readReadyFingerprint<E>(readyMarker: string, fsEffect: FsEffect<E>) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fsEffect(
      "check immutable cache ready marker " + readyMarker,
      fileSystem.exists(readyMarker),
    );
    if (!exists) return null;
    return yield* fileSystem
      .readFileString(readyMarker, "utf8")
      .pipe(
        Effect.catchAll((cause) =>
          Effect.logDebug(
            "ignoring unreadable immutable cache ready marker",
            cause,
          ).pipe(Effect.as(null)),
        ),
      );
  });
}

function createBuildingCache<E>(cacheRoot: string, fsEffect: FsEffect<E>) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fsEffect(
      "create immutable cache root " + cacheRoot,
      fileSystem.makeDirectory(cacheRoot, { recursive: true }),
    );
    return yield* fsEffect(
      "create unique immutable building cache",
      fileSystem.makeTempDirectory({
        directory: cacheRoot,
        prefix: BUILDING_CACHE_PREFIX,
      }),
    );
  });
}

function removeBuildingCacheBestEffort(buildingDir: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.remove(buildingDir, { recursive: true, force: true }),
    ),
    Effect.catchAll((cause) =>
      Effect.logWarning(
        "failed to remove immutable building cache " + buildingDir,
        cause,
      ),
    ),
  );
}

// A hard-killed installer cannot run its ensuring cleanup. The age gate keeps
// one process from deleting another process's in-progress build.
function sweepStaleBuildingCaches(cacheRoot: string, maxAgeMs: number) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem.exists(cacheRoot);
    if (!exists) return;
    const entries = yield* fileSystem.readDirectory(cacheRoot);
    const cutoff = Date.now() - maxAgeMs;
    const buildingDirs = entries
      .filter((entry) => entry.startsWith(BUILDING_CACHE_PREFIX))
      .map((entry) => join(cacheRoot, entry));
    for (const buildingDir of buildingDirs) {
      const info = yield* fileSystem.stat(buildingDir);
      const mtime = Option.getOrNull(info.mtime);
      if (mtime !== null && mtime.getTime() <= cutoff) {
        yield* fileSystem.remove(buildingDir, {
          recursive: true,
          force: true,
        });
      }
    }
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.logWarning(
        "failed to sweep stale immutable building caches in " + cacheRoot,
        cause,
      ),
    ),
    Effect.withSpan("sweepStaleBuildingCaches"),
  );
}

function writeReadyMarker<E>(
  cacheDir: string,
  fingerprint: string,
  fsEffect: FsEffect<E>,
) {
  const readyMarker = readyMarkerPath(cacheDir);
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fsEffect(
        "write immutable cache ready marker " + readyMarker,
        fileSystem.writeFileString(readyMarker, fingerprint),
      ),
    ),
  );
}

function findCacheGeneration<E>(
  cacheRoot: string,
  fingerprint: string,
  fsEffect: FsEffect<E>,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fsEffect(
      "check immutable cache root " + cacheRoot,
      fileSystem.exists(cacheRoot),
    );
    if (!exists) return null;
    const entries = yield* fsEffect(
      "list immutable cache generations " + cacheRoot,
      fileSystem.readDirectory(cacheRoot),
    );
    for (const entry of entries.filter(isCacheGeneration).sort()) {
      const generationDir = join(cacheRoot, entry);
      const readyFingerprint = yield* readReadyFingerprint(
        readyMarkerPath(generationDir),
        fsEffect,
      );
      if (readyFingerprint === fingerprint) return generationDir;
    }
    return null;
  }).pipe(Effect.withSpan("findCacheGeneration"));
}

function publishCacheGeneration<E>(
  cacheRoot: string,
  buildingDir: string,
  fsEffect: FsEffect<E>,
) {
  const generationDir = join(
    cacheRoot,
    CACHE_GENERATION_PREFIX +
      basename(buildingDir).slice(BUILDING_CACHE_PREFIX.length),
  );
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fsEffect(
        "publish immutable cache generation " + generationDir,
        fileSystem.rename(buildingDir, generationDir),
      ),
    ),
    Effect.as(generationDir),
    Effect.withSpan("publishCacheGeneration"),
  );
}

function readyMarkerPath(cacheDir: string): string {
  return join(cacheDir, READY_MARKER);
}

function isCacheGeneration(entry: string): boolean {
  return entry.startsWith(CACHE_GENERATION_PREFIX);
}
