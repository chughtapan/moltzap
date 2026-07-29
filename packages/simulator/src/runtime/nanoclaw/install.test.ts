import { basename, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { nanoclawInstallCache } from "./install.js";

const CACHE_FINGERPRINT = "a".repeat(64);
const OTHER_FINGERPRINT = "b".repeat(64);
const PADDED_FINGERPRINT = CACHE_FINGERPRINT + "\n";
const READY_MARKER = ".ready";
const GENERATION_PREFIX = "generation-";
const FIRST_PAYLOAD = "first";
const SECOND_PAYLOAD = "second";
const PAYLOAD_FILE = "payload";
const PUBLISHED_GENERATION_COUNT = 2;

describe("NanoClaw cache generations", () => {
  it("ignores corrupt and mismatched generations", ignoresInvalidGenerations);
  it("selects a generation with the exact fingerprint", selectsExactGeneration);
  it(
    "publishes concurrent builds to unique generations",
    publishesConcurrently,
  );
  it(
    "sweeps stale building caches but keeps fresh ones and generations",
    sweepsOnlyStaleBuildingCaches,
  );
});

const SWEEP_MAX_AGE_MS = 60_000;

function sweepsOnlyStaleBuildingCaches() {
  return runWithFixture((cacheRoot) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stale = join(cacheRoot, ".building-stale");
      const fresh = join(cacheRoot, ".building-fresh");
      const generation = join(cacheRoot, GENERATION_PREFIX + "keep");
      yield* fileSystem.makeDirectory(stale, { recursive: true });
      yield* fileSystem.makeDirectory(fresh, { recursive: true });
      yield* makeGeneration(generation);
      const staleDate = new Date(Date.now() - SWEEP_MAX_AGE_MS * 2);
      yield* fileSystem.utimes(stale, staleDate, staleDate);

      yield* nanoclawInstallCache(cacheRoot).sweepStaleBuildingCaches(
        SWEEP_MAX_AGE_MS,
      );

      expect(yield* fileSystem.exists(stale)).toBe(false);
      expect(yield* fileSystem.exists(fresh)).toBe(true);
      expect(yield* fileSystem.exists(generation)).toBe(true);
    }),
  );
}

function ignoresInvalidGenerations() {
  return runWithFixture((cacheRoot) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const corrupt = join(cacheRoot, GENERATION_PREFIX + "corrupt");
      yield* fileSystem.makeDirectory(join(corrupt, READY_MARKER), {
        recursive: true,
      });
      yield* makeGeneration(
        join(cacheRoot, GENERATION_PREFIX + "mismatch"),
        OTHER_FINGERPRINT,
      );
      yield* makeGeneration(
        join(cacheRoot, GENERATION_PREFIX + "padded"),
        PADDED_FINGERPRINT,
      );
      yield* makeGeneration(join(cacheRoot, ".building-complete"));

      const found =
        yield* nanoclawInstallCache(cacheRoot).findCacheGeneration(
          CACHE_FINGERPRINT,
        );

      expect(found).toBe(null);
    }),
  );
}

function selectsExactGeneration() {
  return runWithFixture((cacheRoot) =>
    Effect.gen(function* () {
      const expected = join(cacheRoot, GENERATION_PREFIX + "valid");
      yield* makeGeneration(expected);

      const found =
        yield* nanoclawInstallCache(cacheRoot).findCacheGeneration(
          CACHE_FINGERPRINT,
        );

      expect(found).toBe(expected);
    }),
  );
}

function publishesConcurrently() {
  return runWithFixture((cacheRoot) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const firstBuilding = join(cacheRoot, ".building-first");
      const secondBuilding = join(cacheRoot, ".building-second");
      yield* makeGeneration(firstBuilding, CACHE_FINGERPRINT, FIRST_PAYLOAD);
      yield* makeGeneration(secondBuilding, CACHE_FINGERPRINT, SECOND_PAYLOAD);

      const cache = nanoclawInstallCache(cacheRoot);
      const published = yield* Effect.all(
        [
          cache.publishCacheGeneration(firstBuilding),
          cache.publishCacheGeneration(secondBuilding),
        ],
        { concurrency: PUBLISHED_GENERATION_COUNT },
      );

      expect(new Set(published).size).toBe(PUBLISHED_GENERATION_COUNT);
      for (const generationDir of published) {
        expect(basename(generationDir).startsWith(GENERATION_PREFIX)).toBe(
          true,
        );
        expect(yield* fileSystem.exists(generationDir)).toBe(true);
      }
      expect(yield* fileSystem.exists(firstBuilding)).toBe(false);
      expect(yield* fileSystem.exists(secondBuilding)).toBe(false);
      const payloads = yield* Effect.forEach(
        published,
        (generationDir) =>
          fileSystem.readFileString(join(generationDir, PAYLOAD_FILE)),
        { concurrency: PUBLISHED_GENERATION_COUNT },
      );
      expect(new Set(payloads)).toEqual(
        new Set([FIRST_PAYLOAD, SECOND_PAYLOAD]),
      );
      expect(yield* cache.findCacheGeneration(CACHE_FINGERPRINT)).not.toBe(
        null,
      );
    }),
  );
}

function makeGeneration(
  directory: string,
  fingerprint = CACHE_FINGERPRINT,
  payload?: string,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    if (payload !== undefined) {
      yield* fileSystem.writeFileString(join(directory, PAYLOAD_FILE), payload);
    }
    yield* fileSystem.writeFileString(
      join(directory, READY_MARKER),
      fingerprint,
    );
  });
}

function runWithFixture<A, E>(
  use: (cacheRoot: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
) {
  return Effect.runPromise(
    Effect.scoped(
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          fileSystem.makeTempDirectoryScoped({
            prefix: "nanoclaw-cache-generations-",
          }),
        ),
        Effect.flatMap(use),
        Effect.provide(NodeContext.layer),
      ),
    ),
  );
}
