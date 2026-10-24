/** @file Condition-only process composition for adjacent wire releases. */
import { NodeRuntime } from "@effect/platform-node";
import { ConfigProvider, Console, Effect, Layer } from "effect";
import { installInternalResolution } from "./internal-resolution.js";

/** Internal Identity capabilities stay within the Registry process boundary. */
export function startRegistry(versions: {
  readonly emitted?: string;
  readonly live: readonly string[];
  readonly history: readonly string[];
}): void {
  installInternalResolution();
  Effect.gen(function* () {
    const { WireVersions } = yield* Effect.tryPromise(
      () => import("@moltzap/identity/test"),
    );
    const { layer } = yield* Effect.tryPromise(() => import("./server.js"));
    return yield* Layer.launch(layer).pipe(
      Effect.provideService(WireVersions, versions),
    );
  }).pipe(
    Effect.catchAll((error) =>
      Console.error(error.message).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
    Effect.withSpan("startRegistry"),
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    NodeRuntime.runMain,
  );
}
