/** @file Production composition for one explicitly configured endpoint daemon. */

import { NodeHttpClient } from "@effect/platform-node";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import { Data, Duration, Effect, Layer } from "effect";
import {
  loadDaemonBootstrap,
  loadDaemonProcessConfiguration,
} from "./daemon/configuration.js";
import { runDaemonRuntime } from "./daemon/runtime.js";
import { openEndpointStore } from "./endpoint/store.js";

const REGISTRY_REQUEST_TIMEOUT = Duration.seconds(30);
const ROUTER_SEND_TIMEOUT = Duration.seconds(30);
const ROUTER_POLL_TIMEOUT = Duration.seconds(35);

/** Production endpoint-daemon process surface. */
export namespace MoltZapDaemon {
  /** Closed daemon startup phase without configuration or platform detail. */
  export class StartupError extends Data.TaggedError(
    "MoltZapDaemonStartupError",
  )<{
    readonly phase: "configuration" | "storage" | "listener";
  }> {}

  const runDaemon = Effect.gen(function* () {
    const configuration = yield* loadDaemonProcessConfiguration.pipe(
      Effect.mapError(configurationFailure),
    );
    const bootstrap = yield* loadDaemonBootstrap(configuration).pipe(
      Effect.mapError(configurationFailure),
    );
    const store = yield* openEndpointStore(configuration.stateDirectory).pipe(
      Effect.mapError(storageFailure),
    );
    const networkContext = yield* Layer.build(
      Layer.merge(
        Registry.layer({
          origin: configuration.registryOrigin,
          registrySignerPublicKey: configuration.registrySignerPublicKey,
          requestTimeout: REGISTRY_REQUEST_TIMEOUT,
        }),
        Router.layer({
          origin: configuration.routerOrigin,
          sendTimeout: ROUTER_SEND_TIMEOUT,
          pollTimeout: ROUTER_POLL_TIMEOUT,
        }),
      ).pipe(Layer.provide(NodeHttpClient.layer)),
    );
    return yield* runDaemonRuntime({ store, bootstrap }).pipe(
      Effect.provide(networkContext),
      Effect.mapError((error) => new StartupError({ phase: error.phase })),
    );
  }).pipe(Effect.withSpan("MoltZapDaemon.layer"));

  /** Complete production process composition for `moltzapd`. */
  export const layer: Layer.Layer<never, StartupError> =
    Layer.scopedDiscard(runDaemon);

  function configurationFailure(): StartupError {
    return new StartupError({ phase: "configuration" });
  }

  function storageFailure(): StartupError {
    return new StartupError({ phase: "storage" });
  }
}
