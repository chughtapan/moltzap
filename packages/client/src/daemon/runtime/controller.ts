/** @file MCP operations and subscription state for one daemon controller. */

import type { VerifiedAgentCard } from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import { DateTime, Deferred, Effect, Queue, Scope } from "effect";
import type {
  EventStore,
  HarnessReadInboxRequest,
} from "../../harness-mcp-contract.js";
import type { HarnessMcpOperations } from "../../harness-mcp-wire.js";
import type { DaemonBootstrap } from "../configuration.js";
import type { HistoryExportPort } from "./history-export.js";
import {
  DeliveryAcknowledgeError,
  type HistoryExportRecord,
  InboundItem,
  SendError,
  type SendInput,
} from "../../contract.js";
import {
  decodeRuntimeValue,
  type DeliveryToken,
  type EndpointStore,
} from "../../endpoint/store.js";
import {
  readRuntimeEvent,
  readRuntimeInbox,
  recoverRuntimeInbox,
} from "../inbox/index.js";
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
} from "./protocol.js";
import { makeSendInvocations } from "./send-invocations.js";

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
      ),
    );

/**
 * Record one completed `send` in the history export with its input and how it
 * ended: the posts certified by its return, or the error it returned.
 */
const exportSend = (
  environment: ProtocolEnvironment,
  input: SendInput,
  outcome: Extract<
    HistoryExportRecord,
    { readonly kind: "outbound" }
  >["outcome"],
): Effect.Effect<void> =>
  DateTime.now.pipe(
    Effect.flatMap((at) =>
      environment.historyExport.record({
        kind: "outbound",
        input,
        outcome,
        at,
      }),
    ),
  );

const makeSendOperation =
  (environment: ProtocolEnvironment): HarnessMcpOperations["send"] =>
  (request) =>
    Effect.suspend(() => {
      const protocol = environment.state.activeProtocol;
      if (protocol === undefined) {
        return Effect.fail(new SendError({ reason: "not-registered" }));
      }
      return protocol.collectives
        .send(request.input, request.failureDelivery ?? "result")
        .pipe(
          Effect.tapBoth({
            onFailure: (error) =>
              exportSend(environment, request.input, {
                kind: "failed",
                error: error.message,
              }),
            onSuccess: (outcome) =>
              exportSend(environment, request.input, {
                kind: "sent",
                ...outcome,
              }),
          }),
          Effect.map(({ operationId }) =>
            operationId === undefined ? {} : { operationId },
          ),
        );
    });

const forgetDelivery = (
  state: ProtocolState,
  deliveryToken: DeliveryToken,
): Effect.Effect<void> =>
  Effect.sync(() => {
    state.publishedDeliveries.delete(deliveryToken);
    state.exportedDeliveries.delete(deliveryToken);
    state.classifiedItems.delete(deliveryToken);
    state.localItems.delete(deliveryToken);
  });

/**
 * Retire the durable inbox binding before dropping its process-local caches.
 */
const makeAcknowledgeDeliveryOperation =
  (
    state: ProtocolState,
    deliveryGate: Effect.Semaphore,
    store: EndpointStore,
  ): HarnessMcpOperations["acknowledgeDelivery"] =>
  (deliveryToken) =>
    deliveryGate.withPermits(1)(
      Effect.suspend(() => {
        const protocol = state.activeProtocol;
        if (protocol === undefined) {
          return Effect.fail(
            new DeliveryAcknowledgeError({ reason: "unknown-delivery" }),
          );
        }
        const acknowledge = store.acknowledgeInboxItem(deliveryToken).pipe(
          Effect.catchTag("EndpointStoreError", (error) =>
            Effect.fail(
              new DeliveryAcknowledgeError({
                reason:
                  error.reason === "not-found"
                    ? "unknown-delivery"
                    : "persistence-failed",
              }),
            ),
          ),
        );
        return acknowledge.pipe(
          Effect.tap(() => forgetDelivery(state, deliveryToken)),
        );
      }),
    );

const runSubscriptionChanges = (
  environment: ProtocolEnvironment,
  changes: Queue.Queue<boolean>,
  reconciler: Effect.Effect<void>,
): Effect.Effect<never, DaemonRuntimeError> =>
  Queue.take(changes).pipe(
    Effect.flatMap((active) =>
      Effect.sync(() => {
        environment.state.subscriptionActive = active;
        if (!active) {
          environment.state.publishedDeliveries.clear();
        }
      }).pipe(Effect.zipRight(reconciler)),
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

/** Export replayed local items before a host can read them after restart. */
const readAndExportInbox = (
  environment: ProtocolEnvironment,
  gate: Effect.Semaphore,
  request: HarnessReadInboxRequest,
) =>
  gate.withPermits(1)(
    Effect.gen(function* () {
      const page = yield* readRuntimeInbox(environment.store, request);
      for (const entry of page.items) {
        if (!environment.state.exportedDeliveries.has(entry.deliveryToken)) {
          const at = yield* DateTime.now;
          yield* environment.historyExport.record({
            kind: "inbound",
            item: entry.item,
            at,
          });
          environment.state.exportedDeliveries.add(entry.deliveryToken);
        }
      }
      return page;
    }),
  );

interface ControllerAssembly {
  readonly invocations: Effect.Effect.Success<
    ReturnType<typeof makeSendInvocations>
  >;
  readonly environment: ProtocolEnvironment;
  readonly management: DaemonActivationPreparation["management"];
  readonly changes: Queue.Queue<boolean>;
  readonly deliveryGate: Effect.Semaphore;
  readonly reconciler: Effect.Effect<void>;
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
    ...input.invocations,
    readInboxSummary: input.environment.store.readInboxSummary,
    readEvent: ({ eventId }: { readonly eventId: string }) =>
      input.environment.state.activeProtocol === undefined
        ? Effect.fail({ reason: "not-registered" })
        : readRuntimeEvent(input.environment.store, eventId),
    readInbox: (request: HarnessReadInboxRequest) =>
      input.environment.state.activeProtocol === undefined
        ? Effect.fail({ reason: "not-registered" })
        : readAndExportInbox(input.environment, input.deliveryGate, request),
    acknowledgeDelivery: makeAcknowledgeDeliveryOperation(
      input.environment.state,
      input.deliveryGate,
      input.environment.store,
    ),
  });
};

/** Webhook reads share export ordering with native inbox reads. */
const readWebhookInbox = (
  input: ControllerAssembly,
  bounds: Parameters<EndpointStore["readInbox"]>[0],
) =>
  input.deliveryGate.withPermits(1)(
    Effect.gen(function* () {
      const page = yield* input.environment.store.readInbox(bounds);
      for (const entry of page.items) {
        if (
          !input.environment.state.exportedDeliveries.has(entry.deliveryToken)
        ) {
          const item = yield* decodeRuntimeValue(
            InboundItem,
            entry.canonicalItem,
          );
          const at = yield* DateTime.now;
          yield* input.environment.historyExport.record({
            kind: "inbound",
            item,
            at,
          });
          input.environment.state.exportedDeliveries.add(entry.deliveryToken);
        }
      }
      return page;
    }),
  );

const assembleDaemonController = (
  input: ControllerAssembly,
): DaemonController => ({
  operations: controllerOperations(input),
  eventStore: {
    ...input.environment.store,
    readInbox: (bounds) => readWebhookInbox(input, bounds),
    completeWebhookDelivery: (token, bytes) =>
      input.deliveryGate.withPermits(1)(
        input.environment.store
          .completeWebhookDelivery(token, bytes)
          .pipe(
            Effect.tap(() => forgetDelivery(input.environment.state, token)),
          ),
      ),
  },
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

const initialProtocolState = (): ProtocolState => ({
  subscriptionActive: false,
  publishedDeliveries: new Set(),
  localItems: new Map(),
  exportedDeliveries: new Set(),
  classifiedItems: new Map(),
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
    yield* recoverRuntimeInbox(input.store).pipe(
      Effect.mapError(() => runtimeFailure("storage")),
    );
    const registry = yield* Registry;
    const router = yield* Router;
    const daemonScope = yield* Scope.Scope;
    const activationGate = yield* Effect.makeSemaphore(1);
    const deliveryGate = yield* Effect.makeSemaphore(1);
    const changes = yield* Queue.unbounded<boolean>();
    const fatal = yield* Deferred.make<never, DaemonRuntimeError>();
    const state = initialProtocolState();
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
    };
    const reconciler = publishPendingMessages(environment, deliveryGate);
    const invocations = yield* makeSendInvocations(
      input.store,
      makeSendOperation(environment),
      daemonScope,
    );
    const initialize = (agentCard: VerifiedAgentCard) =>
      initializeProtocol(environment, activationGate, reconciler, agentCard);
    return assembleDaemonController({
      invocations,
      environment,
      management: input.management,
      changes,
      deliveryGate,
      reconciler,
      initialize,
    });
  }).pipe(Effect.withSpan("makeDaemonController"));
