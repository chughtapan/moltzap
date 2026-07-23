import { basename, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  findNanoclawCacheGeneration,
  publishNanoclawCacheGeneration,
} from "./nanoclaw-install.js";

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
});

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

      const found = yield* findNanoclawCacheGeneration(
        cacheRoot,
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

      const found = yield* findNanoclawCacheGeneration(
        cacheRoot,
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

      const published = yield* Effect.all(
        [
          publishNanoclawCacheGeneration(firstBuilding, cacheRoot),
          publishNanoclawCacheGeneration(secondBuilding, cacheRoot),
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
      expect(
        yield* findNanoclawCacheGeneration(cacheRoot, CACHE_FINGERPRINT),
      ).not.toBe(null);
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
