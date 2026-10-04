/** @file Protocol acquisition, supervision, and pending-delivery reconciliation. */

import type { VerifiedAgentCard } from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import { Cause, type Context, Deferred, Effect, Schema, Scope } from "effect";
import type { HistoryExportPort } from "../delivery/history-export.js";
import type { HostDelivery } from "../delivery/index.js";
import type { EndpointStore } from "../store/index.js";
import type {
  EndpointEngine,
  EngineInitializationError,
} from "../transport/messaging/index.js";
import type { DaemonBootstrap } from "./bootstrap.js";
import {
  CollectiveEmitError,
  type CollectiveOperations,
  type InboundItem,
  makeCollectiveOperations,
} from "../transport/collectives/index.js";
import { AgentAddress } from "../transport/wire/values.js";
import {
  type RouterWorker,
  type RouterWorkerInput,
  RouterWorkerPayloadInvalidError,
  type RouterWorkerProtocolError,
  type RouterWorkerTransportError,
} from "../transport/router/index.js";
import {
  type DecodedOuterBody,
  decodeOuterBody,
} from "../transport/wire/index.js";
import {
  DaemonActivationError,
  type DaemonRuntimeDependencies,
  DaemonRuntimeError,
  recoverPinnedSenderCards,
} from "./activation/index.js";

/** Subscription publisher installed after the MCP handler is acquired. */
export type RuntimeSubscriptionHandler = Effect.Effect.Success<
  ReturnType<DaemonRuntimeDependencies["makeHandler"]>
>;

/** Engine, Router worker and collective layer active for the daemon's identity. */
interface ActiveProtocol {
  readonly agentCard: VerifiedAgentCard;
  readonly worker: RouterWorker;
  readonly engine: EndpointEngine;
  readonly collectives: CollectiveOperations;
}

/** Mutable controller state shared with supervised protocol resources. */
export interface ProtocolState {
  activeProtocol?: ActiveProtocol;
  subscriptionActive: boolean;
  handler?: RuntimeSubscriptionHandler;
}

/** Dependencies and owned resources available to one protocol lifecycle. */
export interface ProtocolEnvironment {
  readonly store: EndpointStore;
  readonly bootstrap: DaemonBootstrap;
  readonly historyExport: HistoryExportPort;
  readonly dependencies: DaemonRuntimeDependencies;
  readonly registry: Context.Tag.Service<typeof Registry>;
  readonly router: Context.Tag.Service<typeof Router>;
  readonly daemonScope: Scope.Scope;
  readonly fatal: Deferred.Deferred<never, DaemonRuntimeError>;
  readonly state: ProtocolState;
  readonly delivery: HostDelivery;
}

interface AcquireProtocolWorkerInput {
  readonly environment: ProtocolEnvironment;
  readonly agentCard: VerifiedAgentCard;
  readonly pinnedSenderCards: readonly VerifiedAgentCard[];
  readonly awaitEngine: Effect.Effect<EndpointEngine>;
  readonly publishPending: Effect.Effect<void>;
}

const signStructurallyValidAction = () =>
  Effect.succeed<"sign" | "refuse">("sign");

const activationFailure = (
  reason: DaemonActivationError["reason"],
): DaemonActivationError => new DaemonActivationError({ reason });

const runtimeFailure = (
  phase: DaemonRuntimeError["phase"],
): DaemonRuntimeError => new DaemonRuntimeError({ phase });

const mapWorkerInitializationError = (
  error: RouterWorkerTransportError | RouterWorkerProtocolError,
): DaemonActivationError =>
  activationFailure(
    error._tag === "RouterWorkerTransportError" ? "upstream" : "representation",
  );

/**
 * Classify newly durable deliveries and publish what a subscriber can take.
 * The pass runs with or without a subscriber, so the collective layer
 * consumes protocol posts even while no host is attached. The active protocol
 * and subscriber are read once the delivery gate is held. A failed pass
 * releases the gate, signals the storage failure, and fails with it, so
 * startup and registration stop there instead of continuing.
 * @param environment Protocol resources and the service's delivery.
 * @returns Completion after every current delivery is consumed or offered.
 */
export const publishPendingMessages = (
  environment: ProtocolEnvironment,
): Effect.Effect<void, DaemonRuntimeError> =>
  environment.delivery
    .runPass(() => {
      const { state } = environment;
      const protocol = state.activeProtocol;
      if (protocol === undefined) {
        return undefined;
      }
      const handler = state.subscriptionActive ? state.handler : undefined;
      return {
        readPending: protocol.engine.readPendingMessages(),
        engine: protocol.engine,
        classify: protocol.collectives.classify,
        ...(handler === undefined
          ? {}
          : { handler: { publish: handler.notifyPending } }),
      };
    })
    .pipe(
      Effect.catchAll(() => {
        const failure = runtimeFailure("storage");
        return Deferred.fail(environment.fatal, failure).pipe(
          Effect.zipRight(Effect.fail(failure)),
        );
      }),
    );

/**
 * Queue an item the collective layer emitted and start a publication pass.
 * The pass is forked because the layer can emit from inside one, which holds
 * the delivery gate. An item the store cannot keep signals the storage
 * failure and fails the emission, so a pass that emitted it ends and
 * releases the gate.
 */
const emitLocalItem = (
  environment: ProtocolEnvironment,
  reconciler: Effect.Effect<void, DaemonRuntimeError>,
  item: InboundItem,
): Effect.Effect<void, CollectiveEmitError> =>
  environment.delivery.queueLocalItem(item).pipe(
    Effect.catchAll(() =>
      Deferred.fail(environment.fatal, runtimeFailure("storage")).pipe(
        Effect.zipRight(Effect.fail(new CollectiveEmitError())),
      ),
    ),
    Effect.zipRight(
      Effect.forkIn(Effect.ignore(reconciler), environment.daemonScope),
    ),
    Effect.asVoid,
  );

/**
 * Propagate interruption and convert other background failures to daemon failure.
 * @param fatal Process-wide failure signal.
 * @param cause Background fiber cause to classify.
 * @returns An effect that preserves interruption or waits after signaling fatal.
 */
export const failFromBackgroundCause = <E>(
  fatal: Deferred.Deferred<never, DaemonRuntimeError>,
  cause: Cause.Cause<E>,
): Effect.Effect<never, E> => {
  if (Cause.isInterruptedOnly(cause)) {
    return Effect.failCause(cause);
  }
  return Deferred.fail(fatal, runtimeFailure("listener")).pipe(
    Effect.zipRight(Effect.never),
  );
};

const superviseBackground = (
  environment: ProtocolEnvironment,
  effect: Effect.Effect<never, unknown>,
) =>
  effect.pipe(
    Effect.catchAllCause((cause) =>
      failFromBackgroundCause(environment.fatal, cause),
    ),
    Effect.interruptible,
    Effect.forkIn(environment.daemonScope),
    Effect.asVoid,
  );

const makeWorkerCallbacks = (
  awaitEngine: Effect.Effect<EndpointEngine>,
  publishPending: Effect.Effect<void>,
): RouterWorkerInput<DecodedOuterBody>["callbacks"] => ({
  pinSenderCard: () => awaitEngine.pipe(Effect.asVoid),
  decodePayload: (message) =>
    decodeOuterBody(message.body).pipe(
      Effect.catchTag("ClientRepresentationError", () =>
        Effect.fail(new RouterWorkerPayloadInvalidError()),
      ),
    ),
  acceptPayload: (ingress) =>
    awaitEngine.pipe(
      Effect.flatMap((engine) => engine.acceptRouterIngress(ingress)),
      Effect.tap(() => publishPending),
    ),
  acceptRecoveryPayload: (ingress) =>
    awaitEngine.pipe(
      Effect.flatMap((engine) => engine.acceptRecoveryIngress(ingress)),
      Effect.tap(() => publishPending),
    ),
  abandonVolatileFolds: (reason) =>
    awaitEngine.pipe(
      Effect.flatMap((engine) => engine.abandonVolatileFolds(reason)),
    ),
  recoverCertifiedHistory: (recovery) =>
    awaitEngine.pipe(
      Effect.flatMap((engine) => engine.recoverCertifiedHistory(recovery)),
      Effect.tap(() => publishPending),
    ),
});

const acquireProtocolWorker = (input: AcquireProtocolWorkerInput) =>
  input.environment.dependencies
    .makeWorker({
      callerAgentId: input.agentCard.agentId,
      callerAgentCard: input.agentCard,
      pinnedSenderCards: input.pinnedSenderCards,
      signingAuthority: input.environment.bootstrap.signingAuthority,
      outbox: input.environment.store,
      callbacks: makeWorkerCallbacks(input.awaitEngine, input.publishPending),
    })
    .pipe(
      Effect.provideService(Registry, input.environment.registry),
      Effect.provideService(Router, input.environment.router),
      Effect.mapError(mapWorkerInitializationError),
    );

const mapEngineInitializationError = (
  error: EngineInitializationError,
): DaemonActivationError =>
  activationFailure(
    error.reason === "identity" ? "representation" : error.reason,
  );

const acquireProtocolEngine = (
  environment: ProtocolEnvironment,
  agentCard: VerifiedAgentCard,
  worker: RouterWorker,
) =>
  environment.dependencies
    .makeEngine({
      localAgentCard: agentCard,
      signingAuthority: environment.bootstrap.signingAuthority,
      registrySignerPublicKey:
        environment.bootstrap.configuration.registrySignerPublicKey,
      registry: environment.registry,
      store: environment.store,
      routerWorker: worker,
      actionPolicy: signStructurallyValidAction,
    })
    .pipe(
      Scope.extend(environment.daemonScope),
      Effect.mapError(mapEngineInitializationError),
    );

const checkExistingProtocol = (
  agentCard: VerifiedAgentCard,
  activeProtocol?: ActiveProtocol,
): Effect.Effect<boolean, DaemonActivationError> => {
  if (activeProtocol === undefined) {
    return Effect.succeed(false);
  }
  if (
    activeProtocol.agentCard.agentId !== agentCard.agentId ||
    activeProtocol.agentCard.publicKey.x !== agentCard.publicKey.x
  ) {
    return Effect.fail(activationFailure("representation"));
  }
  return Effect.succeed(true);
};

/**
 * The collective layer for the active identity: it certifies posts through
 * the engine and queues the items it emits for the next publication pass.
 */
const makeProtocolCollectives = (
  environment: ProtocolEnvironment,
  reconciler: Effect.Effect<void, DaemonRuntimeError>,
  agentCard: VerifiedAgentCard,
  engine: EndpointEngine,
): CollectiveOperations =>
  makeCollectiveOperations({
    self: Schema.decodeUnknownSync(AgentAddress)(
      `agent:${agentCard.agentName}`,
    ),
    lookupMember: (member) => engine.resolveAddress(member),
    sendPost: (input) => engine.send(input),
    emit: (item) => emitLocalItem(environment, reconciler, item),
    scope: environment.daemonScope,
  });

/** Hold the active protocol with its collective layer for later operations. */
const retainActiveProtocol = (
  environment: ProtocolEnvironment,
  reconciler: Effect.Effect<void, DaemonRuntimeError>,
  protocol: Omit<ActiveProtocol, "collectives">,
): void => {
  environment.state.activeProtocol = {
    ...protocol,
    collectives: makeProtocolCollectives(
      environment,
      reconciler,
      protocol.agentCard,
      protocol.engine,
    ),
  };
};

/**
 * Acquire and supervise the protocol resources for one immutable daemon identity.
 * @param environment Daemon-owned dependencies and resource scope.
 * @param activationGate Serializes registration and restart activation.
 * @param reconciler Publishes durable pending deliveries after transitions.
 * @param agentCard Verified local identity to activate.
 * @returns Completion after engine and worker fibers are running.
 */
export const initializeProtocol = (
  environment: ProtocolEnvironment,
  activationGate: Effect.Semaphore,
  reconciler: Effect.Effect<void, DaemonRuntimeError>,
  agentCard: VerifiedAgentCard,
): Effect.Effect<void, DaemonActivationError> =>
  activationGate
    .withPermits(1)(
      Effect.gen(function* () {
        const alreadyActive = yield* checkExistingProtocol(
          agentCard,
          environment.state.activeProtocol,
        );
        if (alreadyActive) {
          return;
        }
        const pinnedSenderCards = yield* recoverPinnedSenderCards({
          store: environment.store,
          localAgentCard: agentCard,
          bootstrap: environment.bootstrap,
        });
        const engineReady = yield* Deferred.make<EndpointEngine>();
        const awaitEngine = Deferred.await(engineReady);
        const worker = yield* acquireProtocolWorker({
          environment,
          agentCard,
          pinnedSenderCards,
          awaitEngine,
          publishPending: Effect.ignore(reconciler),
        });
        const engine = yield* acquireProtocolEngine(
          environment,
          agentCard,
          worker,
        );
        retainActiveProtocol(environment, reconciler, {
          agentCard,
          worker,
          engine,
        });
        yield* Deferred.succeed(engineReady, engine);
        yield* superviseBackground(environment, worker.run);
        yield* superviseBackground(environment, engine.runOutbound);
        yield* reconciler.pipe(
          Effect.mapError(() => activationFailure("persistence")),
        );
      }),
    )
    .pipe(Effect.withSpan("initializeProtocol"));
