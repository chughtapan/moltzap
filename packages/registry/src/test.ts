/** @file Condition-only process composition for adjacent wire releases. */
import { NodeRuntime } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "sharness-internal"],
    });
  },
});

/** Internal Identity capabilities stay within the Registry process boundary. */
export function startRegistry(versions: {
  readonly emitted?: string;
  readonly live: readonly string[];
  readonly history: readonly string[];
}): void {
  Effect.gen(function* () {
    const { WireVersions } = yield* Effect.tryPromise(
      () => import("@moltzap/identity/test"),
    );
    const { layer } = yield* Effect.tryPromise(() => import("./server.js"));
    return yield* Layer.launch(layer).pipe(
      Effect.provideService(WireVersions, versions),
    );
  }).pipe(
    Effect.withSpan("startRegistry"),
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    NodeRuntime.runMain,
  );
}
