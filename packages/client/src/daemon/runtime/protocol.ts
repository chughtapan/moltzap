/** @file Protocol acquisition, supervision, and pending-delivery reconciliation. */

import type { VerifiedAgentCard } from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import { Cause, type Context, Deferred, Effect, Option, Scope } from "effect";
import type { DeliveryAcknowledgeError, InboundItem } from "../../contract.js";
import type { HistoryExportPort } from "../../endpoint/engine-types.js";
import type {
  EndpointEngine,
  EngineInitializationError,
  EnginePendingMessage,
} from "../../endpoint/engine.js";
import type { EndpointStore } from "../../endpoint/store.js";
import type { HarnessMessageReadyEvent } from "../../harness-mcp-contract.js";
import type { DaemonBootstrap } from "../configuration.js";
import { inboundItem } from "../../endpoint/collective/operation.js";
import { decodeOuterBody } from "../../endpoint/representation.js";
import {
  type RouterWorker,
  type RouterWorkerInput,
  RouterWorkerPayloadInvalidError,
  type RouterWorkerProtocolError,
  type RouterWorkerTransportError,
} from "../../endpoint/router-worker/index.js";
import {
  DaemonActivationError,
  type DaemonRuntimeDependencies,
  DaemonRuntimeError,
  recoverPinnedSenderCards,
} from "./activation.js";

/** Subscription publisher installed after the MCP handler is acquired. */
export type RuntimeSubscriptionHandler = Effect.Effect.Success<
  ReturnType<DaemonRuntimeDependencies["makeHandler"]>
>;

/** Engine and Router worker active for the daemon's immutable identity. */
interface ActiveProtocol {
  readonly agentCard: VerifiedAgentCard;
  readonly worker: RouterWorker;
  readonly engine: EndpointEngine;
}

/** Mutable controller state shared with supervised protocol resources. */
export interface ProtocolState {
  activeProtocol?: ActiveProtocol;
  subscriptionActive: boolean;
  handler?: RuntimeSubscriptionHandler;
  readonly publishedDeliveries: Set<string>;
}

/**
 * Decides what one unpublished pending delivery becomes: the item the
 * subscriber receives, or none when a layer inside the daemon consumes it.
 * The daemon acknowledges a consumed delivery and never publishes it.
 */
export type PendingClassifier = (
  pending: EnginePendingMessage,
) => Effect.Effect<Option.Option<InboundItem>>;

/** The classifier the daemon installs: each post becomes its operation's item. */
export const publishOperationItems: PendingClassifier = (pending) =>
  inboundItem(pending.message);

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
  readonly classifyPending: PendingClassifier;
}

/** What one pass over pending deliveries reads and changes. */
export interface PendingOffer {
  readonly engine: Pick<EndpointEngine, "acknowledgeMessage">;
  readonly handler: Pick<RuntimeSubscriptionHandler, "publish">;
  readonly publishedDeliveries: Set<string>;
  readonly classifyPending: PendingClassifier;
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
 * Consume or publish one unpublished pending delivery.
 * @param offer The engine, subscriber, published set, and classifier.
 * @param pending One delivery the subscriber has not been offered.
 * @returns False when the subscriber refused the item, true otherwise.
 */
const offerPending = (
  offer: PendingOffer,
  pending: EnginePendingMessage,
): Effect.Effect<boolean, DeliveryAcknowledgeError> =>
  offer.classifyPending(pending).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          offer.engine
            .acknowledgeMessage(pending.deliveryToken)
            .pipe(Effect.as(true)),
        onSome: (item) =>
          Effect.sync(() => {
            const event: HarnessMessageReadyEvent = {
              deliveryToken: pending.deliveryToken,
              item,
            };
            if (!offer.handler.publish(event)) {
              return false;
            }
            offer.publishedDeliveries.add(pending.deliveryToken);
            return true;
          }),
      }),
    ),
  );

/**
 * Offer pending deliveries in order: acknowledge each one the classifier
 * consumes and publish the rest, stopping at the first the subscriber refuses.
 * The published event carries only the delivery token and item.
 * @param offer The engine, subscriber, published set, and classifier.
 * @param messages Pending deliveries in durable order.
 * @returns Completion after every offered delivery is consumed or published.
 */
export const offerPendingMessages = (
  offer: PendingOffer,
  messages: readonly EnginePendingMessage[],
): Effect.Effect<void, DeliveryAcknowledgeError> =>
  Effect.gen(function* () {
    for (const pending of messages) {
      if (offer.publishedDeliveries.has(pending.deliveryToken)) {
        continue;
      }
      const accepted = yield* offerPending(offer, pending);
      if (!accepted) {
        return;
      }
    }
  }).pipe(Effect.withSpan("offerPendingMessages"));

/**
 * Publish newly durable messages while one active native subscriber exists.
 * @param environment Protocol resources and controller-owned delivery state.
 * @param deliveryGate Serializes pending reads with subscription changes.
 * @returns Completion after every currently publishable delivery is offered.
 */
export const publishPendingMessages = (
  environment: ProtocolEnvironment,
  deliveryGate: Effect.Semaphore,
): Effect.Effect<void> =>
  deliveryGate.withPermits(1)(
    Effect.suspend(() => {
      const protocol = environment.state.activeProtocol;
      if (!environment.state.subscriptionActive || protocol === undefined) {
        return Effect.void;
      }
      return protocol.engine.readPendingMessages().pipe(
        Effect.flatMap((messages) => {
          const handler = environment.state.handler;
          return handler === undefined
            ? Effect.void
            : offerPendingMessages(
                {
                  engine: protocol.engine,
                  handler,
                  publishedDeliveries: environment.state.publishedDeliveries,
                  classifyPending: environment.classifyPending,
                },
                messages,
              );
        }),
        Effect.catchAll(() =>
          Deferred.fail(environment.fatal, runtimeFailure("storage")).pipe(
            Effect.asVoid,
          ),
        ),
      );
    }),
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
): RouterWorkerInput["callbacks"] => ({
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
      historyExport: environment.historyExport,
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

const retainActiveProtocol = (
  state: ProtocolState,
  protocol: ActiveProtocol,
): void => {
  state.activeProtocol = protocol;
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
  reconciler: Effect.Effect<void>,
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
          publishPending: reconciler,
        });
        const engine = yield* acquireProtocolEngine(
          environment,
          agentCard,
          worker,
        );
        retainActiveProtocol(environment.state, { agentCard, worker, engine });
        yield* Deferred.succeed(engineReady, engine);
        yield* superviseBackground(environment, worker.run);
        yield* superviseBackground(environment, engine.runOutbound);
        yield* reconciler.pipe(
          Effect.mapError(() => activationFailure("upstream")),
        );
      }),
    )
    .pipe(Effect.withSpan("initializeProtocol"));
