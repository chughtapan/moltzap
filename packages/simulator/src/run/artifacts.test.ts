/** @file Large runtime evidence streams to retained files with digest-bound completion. */
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Exit, Stream } from "effect";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
  filesystemRuntimeArtifactStore,
  RuntimeArtifactStore,
} from "./artifacts.js";

it.scoped("writes every chunk and hashes the exact bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const block = new TextEncoder().encode("hello 🌍\n".repeat(8192));
    const blocks = Array.from({ length: 64 }, () => block);
    const result = yield* Effect.flatMap(RuntimeArtifactStore, (store) =>
      store.write("runtime/alice/openclaw.log", Stream.fromIterable(blocks)),
    ).pipe(Effect.provide(filesystemRuntimeArtifactStore(root)));
    const expected = createHash("sha256");
    for (const bytes of blocks) {
      expected.update(bytes);
    }
    expect(result.byteLength).toBe(block.length * blocks.length);
    expect(result.sha256).toBe(expected.digest("hex"));
    expect((yield* fs.stat(`${root}/${result.key}`)).size).toBe(
      BigInt(result.byteLength),
    );
  }).pipe(Effect.provide(NodeContext.layer)),
);

it.scoped(
  "does not publish successful metadata after an interrupted artifact stream",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const chunks = Stream.concat(
        Stream.make(new Uint8Array([1, 2, 3])),
        Stream.fail("connection lost"),
      );
      const result = yield* Effect.exit(
        Effect.flatMap(RuntimeArtifactStore, (store) =>
          store.write("runtime/alice/runtime.stdout.log", chunks),
        ).pipe(Effect.provide(filesystemRuntimeArtifactStore(root))),
      );
      expect(Exit.isFailure(result)).toBe(true);
      const bad = yield* Effect.exit(
        Effect.flatMap(RuntimeArtifactStore, (store) =>
          store.write("../escape", Stream.empty),
        ).pipe(Effect.provide(filesystemRuntimeArtifactStore(root))),
      );
      expect(Exit.isFailure(bad)).toBe(true);
    }).pipe(Effect.provide(NodeContext.layer)),
);
