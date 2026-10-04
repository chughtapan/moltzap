/** @file Production composition for one explicitly configured endpoint daemon. */

import { NodeHttpClient } from "@effect/platform-node";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import { Data, Duration, Effect, Layer } from "effect";
import type { DaemonConfigurationError } from "./bootstrap.js";
import { openEndpointStore } from "../store/index.js";
import {
  loadDaemonBootstrap,
  loadDaemonProcessConfiguration,
} from "./configuration.js";
import { runDaemonRuntime } from "./lifecycle.js";
import {
  type DaemonRegistrationPersistenceError,
  requireAdmissionWhileUnregistered,
} from "./registration/index.js";

const REGISTRY_REQUEST_TIMEOUT = Duration.seconds(30);
const ROUTER_SEND_TIMEOUT = Duration.seconds(30);
const ROUTER_POLL_TIMEOUT = Duration.seconds(35);

// eslint-disable-next-line @typescript-eslint/no-namespace -- The published service subpath intentionally merges its runtime values with the closed startup-error type.
export namespace MoltZapService {
  /** Closed daemon startup phase without configuration or platform detail. */
  export class StartupError extends Data.TaggedError(
    "MoltZapServiceStartupError",
  )<{
    readonly phase: "configuration" | "storage" | "listener";
  }> {
    /**
     * Names only the failed phase, so the process log says why startup stopped.
     * @returns The startup failure message.
     */
    override get message(): string {
      return `moltzapd startup failed in phase ${this.phase}`;
    }
  }

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
    yield* requireAdmissionWhileUnregistered({ store, bootstrap }).pipe(
      Effect.mapError(admissionFailure),
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
      // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- The public process layer deliberately projects private runtime failures onto its closed startup phase.
      Effect.mapError((error) => new StartupError({ phase: error.phase })),
    );
  }).pipe(Effect.withSpan("MoltZapService.layer"));

  /** Complete production process composition for `moltzapd`. */
  export const layer: Layer.Layer<never, StartupError> =
    Layer.scopedDiscard(runDaemon);

  function configurationFailure(): StartupError {
    return new StartupError({ phase: "configuration" });
  }

  function storageFailure(): StartupError {
    return new StartupError({ phase: "storage" });
  }

  function admissionFailure(
    error: DaemonConfigurationError | DaemonRegistrationPersistenceError,
  ): StartupError {
    switch (error._tag) {
      case "DaemonConfigurationError":
        return configurationFailure();
      case "DaemonRegistrationPersistenceError":
        return storageFailure();
      default: {
        const exhaustive: never = error;
        return exhaustive;
      }
    }
  }
}
