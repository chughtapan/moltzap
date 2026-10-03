/** @file MCP operations and subscription state for one daemon controller. */

import type { VerifiedAgentCard } from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import { Deferred, Effect, Queue, Scope } from "effect";
import type { HistoryExportPort } from "../delivery/history-export.js";
import type { EventStore } from "../delivery/operations.js";
import type { HarnessMcpOperations } from "../endpoint/mcp/index.js";
import type { EndpointStore } from "../store/index.js";
import type { DaemonBootstrap } from "./configuration.js";
import { makeHostDelivery } from "../delivery/index.js";
import {
  type DaemonActivationError,
  type DaemonActivationPreparation,
  type DaemonRuntimeDependencies,
  DaemonRuntimeError,
  finishRegistration,
  type InitializeProtocol,
} from "./activation.js";
import {
  failFromBackgroundCause,
  initializeProtocol,
  type ProtocolEnvironment,
  type ProtocolState,
  publishPendingMessages,
  type RuntimeSubscriptionHandler,
} from "./supervision.js";

interface DaemonControllerInput {
  readonly store: EndpointStore;
  readonly bootstrap: DaemonBootstrap;
  readonly historyExport: HistoryExportPort;
  readonly management: DaemonActivationPreparation["management"];
  readonly dependencies: DaemonRuntimeDependencies;
}

/** Controller operations consumed by the daemon composition root. */
export interface DaemonController {
  readonly operations: HarnessMcpOperations;
  readonly eventStore: EventStore;
  readonly subscriptionChanged: (active: boolean) => void;
  readonly installHandler: (
    handler: RuntimeSubscriptionHandler,
  ) => Effect.Effect<void>;
  readonly runSubscriptions: Effect.Effect<never, DaemonRuntimeError>;
  readonly awaitFailure: Effect.Effect<never, DaemonRuntimeError>;
  readonly initializeAtStart: (
    state: DaemonActivationPreparation["registration"],
  ) => Effect.Effect<void, DaemonRuntimeError>;
}

const runtimeFailure = (
  phase: DaemonRuntimeError["phase"],
): DaemonRuntimeError => new DaemonRuntimeError({ phase });

const activationRuntimeFailure = (
  error: DaemonActivationError,
): DaemonRuntimeError =>
  runtimeFailure(error.reason === "upstream" ? "listener" : "storage");

/**
 * The register tool's closed reason for an activation failure: a local
 * storage fault is persistence-failed; an upstream or representation fault
 * is dependency-unavailable.
 */
const registerFailureReason = (
  reason: DaemonActivationError["reason"],
): "persistence-failed" | "dependency-unavailable" => {
  switch (reason) {
    case "persistence":
      return "persistence-failed";
    case "upstream":
    case "representation":
      return "dependency-unavailable";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
};

const makeRegisterOperation =
  (
    environment: ProtocolEnvironment,
    management: DaemonActivationPreparation["management"],
    initialize: InitializeProtocol,
  ): HarnessMcpOperations["register"] =>
  (request) =>
    Effect.uninterruptible(
      management.register(request).pipe(
        Effect.flatMap((result) =>
          finishRegistration(
            {
              store: environment.store,
              bootstrap: environment.bootstrap,
              fatal: environment.fatal,
              initialize,
            },
            result,
          ),
        ),
        Effect.catchTag("DaemonActivationError", (error) =>
          Effect.fail({ reason: registerFailureReason(error.reason) }),
        ),
      ),
    );

const runSubscriptionChanges = (
  environment: ProtocolEnvironment,
  changes: Queue.Queue<boolean>,
  reconciler: Effect.Effect<void, DaemonRuntimeError>,
): Effect.Effect<never, DaemonRuntimeError> =>
  Queue.take(changes).pipe(
    Effect.flatMap((active) =>
      Effect.sync(() => {
        environment.state.subscriptionActive = active;
      }).pipe(
        Effect.zipRight(active ? Effect.void : environment.delivery.detach),
        Effect.zipRight(Effect.ignore(reconciler)),
      ),
    ),
    Effect.forever,
    Effect.catchAllCause((cause) =>
      failFromBackgroundCause(environment.fatal, cause),
    ),
  );

const initializeAtStart = (
  initialize: InitializeProtocol,
  state: DaemonActivationPreparation["registration"],
): Effect.Effect<void, DaemonRuntimeError> => {
  if (state.kind === "unregistered") {
    return Effect.void;
  }
  return initialize(state.agentCard).pipe(
    Effect.mapError(activationRuntimeFailure),
  );
};

interface ControllerAssembly {
  readonly environment: ProtocolEnvironment;
  readonly management: DaemonActivationPreparation["management"];
  readonly changes: Queue.Queue<boolean>;
  readonly reconciler: Effect.Effect<void, DaemonRuntimeError>;
  readonly initialize: InitializeProtocol;
}

const controllerOperations = (
  input: ControllerAssembly,
): HarnessMcpOperations => {
  const register = makeRegisterOperation(
    input.environment,
    input.management,
    input.initialize,
  );
  return Object.freeze({
    ...input.management,
    register,
    ...input.environment.delivery.operations,
  });
};

const assembleDaemonController = (
  input: ControllerAssembly,
): DaemonController => ({
  operations: controllerOperations(input),
  eventStore: input.environment.delivery.eventStore,
  subscriptionChanged: (active) => {
    input.changes.unsafeOffer(active);
  },
  installHandler: (handler) =>
    Effect.sync(() => {
      input.environment.state.handler = handler;
      input.changes.unsafeOffer(handler.hasActiveSubscription());
    }),
  runSubscriptions: runSubscriptionChanges(
    input.environment,
    input.changes,
    input.reconciler,
  ),
  awaitFailure: Deferred.await(input.environment.fatal),
  initializeAtStart: (state) => initializeAtStart(input.initialize, state),
});

/**
 * Acquire the daemon's protocol controller without starting the MCP listener.
 * @param input Durable store, bootstrap configuration, and process dependencies.
 * @returns Controller operations and supervised lifecycle effects.
 */
export const makeDaemonController = (
  input: DaemonControllerInput,
): Effect.Effect<
  DaemonController,
  DaemonRuntimeError,
  Registry | Router | Scope.Scope
> =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const router = yield* Router;
    const daemonScope = yield* Scope.Scope;
    const activationGate = yield* Effect.makeSemaphore(1);
    const changes = yield* Queue.unbounded<boolean>();
    const fatal = yield* Deferred.make<never, DaemonRuntimeError>();
    const state: ProtocolState = { subscriptionActive: false };
    const delivery = yield* makeHostDelivery({
      store: input.store,
      historyExport: input.historyExport,
      collectives: () => state.activeProtocol?.collectives,
      scope: daemonScope,
    }).pipe(Effect.mapError(() => runtimeFailure("storage")));
    const environment: ProtocolEnvironment = {
      store: input.store,
      bootstrap: input.bootstrap,
      historyExport: input.historyExport,
      dependencies: input.dependencies,
      registry,
      router,
      daemonScope,
      fatal,
      state,
      delivery,
    };
    const reconciler = publishPendingMessages(environment);
    const initialize = (agentCard: VerifiedAgentCard) =>
      initializeProtocol(environment, activationGate, reconciler, agentCard);
    return assembleDaemonController({
      environment,
      management: input.management,
      changes,
      reconciler,
      initialize,
    });
  }).pipe(Effect.withSpan("makeDaemonController"));
