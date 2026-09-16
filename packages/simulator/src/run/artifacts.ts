/** @file Stream native files beside the ledger and return their content hashes. */
import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

/** A native artifact could not be completely retained. */
export class RuntimeArtifactError extends Schema.TaggedError<RuntimeArtifactError>()(
  "RuntimeArtifactError",
  { detail: Schema.String },
) {}
/** Complete file identity placed in the immutable ledger. */
export interface RuntimeArtifact {
  readonly key: string;
  readonly sha256: string;
  readonly byteLength: number;
}
/** Retention service supplied by the controller's export volume. */
export class RuntimeArtifactStore extends Context.Tag(
  "@moltzap/simulator/RuntimeArtifactStore",
)<
  RuntimeArtifactStore,
  {
    readonly write: (
      key: string,
      chunks: Stream.Stream<Uint8Array, unknown>,
    ) => Effect.Effect<RuntimeArtifact, RuntimeArtifactError>;
  }
>() {}

/** Use the same retained local or GCS volume as the ledger. */
export function filesystemRuntimeArtifactStore(root: string) {
  return Layer.effect(
    RuntimeArtifactStore,
    Effect.map(FileSystem.FileSystem, (fs) => ({
      write: (key: string, chunks: Stream.Stream<Uint8Array, unknown>) =>
        writeArtifact(fs, root, key, chunks),
    })).pipe(Effect.withSpan("filesystemRuntimeArtifactStore")),
  );
}

function writeArtifact(
  fs: FileSystem.FileSystem,
  root: string,
  key: string,
  chunks: Stream.Stream<Uint8Array, unknown>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      if (
        !/^runtime\/[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(
          key,
        )
      ) {
        return yield* new RuntimeArtifactError({
          detail: "Invalid runtime artifact key",
        });
      }
      const target = join(root, key);
      yield* fs.makeDirectory(dirname(target), { recursive: true });
      // The retained volume crosses controller/host UIDs; its parent is private.
      const file = yield* fs.open(target, { flag: "w", mode: 0o644 });
      const hash = createHash("sha256");
      let byteLength = 0;
      yield* chunks.pipe(
        Stream.runForEach((bytes) =>
          Effect.gen(function* () {
            yield* file.writeAll(bytes);
            hash.update(bytes);
            byteLength += bytes.length;
          }),
        ),
      );
      yield* file.sync;
      return { key, sha256: hash.digest("hex"), byteLength };
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof RuntimeArtifactError
        ? cause
        : new RuntimeArtifactError({ detail: String(cause) }),
    ),
  );
}
