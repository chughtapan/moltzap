/** @file Condition-only process composition for adjacent wire releases. */
import { Effect, Layer } from "effect";
import {
  installInternalResolution,
  runRegistryMain,
} from "./internal-resolution.js";

/** Internal Identity capabilities stay within the Registry process boundary. */
export function startRegistry(versions: {
  readonly emitted?: string;
  readonly live: readonly string[];
  readonly history: readonly string[];
}): void {
  installInternalResolution();
  Effect.gen(function* () {
    const { WireVersions } = yield* Effect.tryPromise({
      try: () => import("@moltzap/identity/test"),
      catch: (cause) => cause,
    });
    const { layer } = yield* Effect.tryPromise({
      try: () => import("./server.js"),
      catch: (cause) => cause,
    });
    return yield* Layer.launch(layer).pipe(
      Effect.provideService(WireVersions, versions),
    );
  }).pipe(Effect.withSpan("startRegistry"), runRegistryMain);
}
