/** @file Acquisition and supervision of the protocol one daemon identity runs. */

import {
  AgentCard,
  type AgentId,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import { Cause, type Context, Deferred, Effect, Schema, Scope } from "effect";
import type { EndpointStore, StoredMembership } from "../../store/index.js";
import type {
  EndpointEngine,
  EndpointEngineInput,
  EngineInitializationError,
} from "../../transport/messaging/index.js";
import type { DaemonBootstrap } from "../bootstrap.js";
import {
  type CollectiveEmitError,
  type CollectiveOperations,
  type InboundItem,
  makeCollectiveOperations,
} from "../../transport/collectives/index.js";
import {
  type RouterWorker,
  type RouterWorkerInput,
  RouterWorkerPayloadInvalidError,
  type RouterWorkerProtocolError,
  type RouterWorkerTransportError,
} from "../../transport/router/index.js";
import {
  decodeCanonical,
  type DecodedOuterBody,
  decodeOuterBody,
  encodeCanonical,
  MembershipDescriptor,
  verifyMembershipDescriptor,
} from "../../transport/wire/index.js";
import { AgentAddress, compareAscii } from "../../transport/wire/values.js";
import {
  activationFailure,
  type DaemonActivationError,
  type DaemonRuntimeError,
  runtimeFailure,
} from "../errors.js";

/** The Router worker and engine constructors a daemon activates its protocol with. */
export interface ProtocolEdges {
  readonly makeWorker: (
    input: RouterWorkerInput<DecodedOuterBody>,
  ) => Effect.Effect<
    RouterWorker,
    RouterWorkerTransportError | RouterWorkerProtocolError,
    Registry | Router
  >;
  readonly makeEngine: (
    input: EndpointEngineInput,
  ) => Effect.Effect<EndpointEngine, EngineInitializationError, Scope.Scope>;
}

/** Engine, Router worker and collective layer active for the daemon's identity. */
export interface ActiveProtocol {
  readonly agentCard: VerifiedAgentCard;
  readonly worker: RouterWorker;
  readonly engine: EndpointEngine;
  readonly collectives: CollectiveOperations;
}

/** The daemon resources a protocol is acquired from and supervised in. */
export interface ProtocolEnvironment {
  readonly store: EndpointStore;
  readonly bootstrap: DaemonBootstrap;
  readonly edges: ProtocolEdges;
  readonly registry: Context.Tag.Service<typeof Registry>;
  readonly router: Context.Tag.Service<typeof Router>;
  readonly daemonScope: Scope.Scope;
  readonly fatal: Deferred.Deferred<never, DaemonRuntimeError>;
}

/** How an acquired protocol reaches back into the daemon that runs it. */
export interface ProtocolHooks {
  /** Holds the protocol before any worker callback can reach its engine. */
  readonly retain: (protocol: ActiveProtocol) => void;
  /** A delivery pass after ingress; its failure has already reached `fatal`. */
  readonly publishPending: Effect.Effect<void>;
  /** Keeps an item the collective layer emitted and publishes it. */
  readonly emit: (
    item: InboundItem,
  ) => Effect.Effect<void, CollectiveEmitError>;
}

interface PinnedCards {
  readonly cards: Map<AgentId, VerifiedAgentCard>;
  readonly representations: Map<AgentId, Uint8Array>;
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

const encodeCard = (
  card: VerifiedAgentCard,
): Effect.Effect<Uint8Array, DaemonActivationError> =>
  encodeCanonical(AgentCard, card).pipe(
    Effect.mapError(() => activationFailure("representation")),
  );

const retainPinnedCard = (
  pinned: PinnedCards,
  card: VerifiedAgentCard,
): Effect.Effect<void, DaemonActivationError> =>
  Effect.gen(function* () {
    const canonical = yield* encodeCard(card);
    const existing = pinned.representations.get(card.agentId);
    if (existing !== undefined && !sameBytes(existing, canonical)) {
      return yield* Effect.fail(activationFailure("representation"));
    }
    pinned.cards.set(card.agentId, card);
    pinned.representations.set(card.agentId, canonical);
  });

const retainMembershipCards = (
  input: {
    readonly bootstrap: DaemonBootstrap;
    readonly pinned: PinnedCards;
  },
  stored: StoredMembership,
): Effect.Effect<void, DaemonActivationError> =>
  Effect.gen(function* () {
    const membership = yield* decodeCanonical(
      MembershipDescriptor,
      stored.canonicalMembership,
    ).pipe(Effect.mapError(() => activationFailure("representation")));
    const verified = yield* verifyMembershipDescriptor(
      membership,
      input.bootstrap.configuration.registrySignerPublicKey,
    ).pipe(Effect.mapError(() => activationFailure("representation")));
    if (
      membership.conversationId !== stored.conversationId ||
      verified.hash !== stored.membershipHash
    ) {
      return yield* Effect.fail(activationFailure("representation"));
    }
    yield* Effect.forEach(
      verified.members,
      (card) => retainPinnedCard(input.pinned, card),
      { concurrency: 1, discard: true },
    );
  });

/**
 * The unique canonical sender cards pinned by durable memberships, plus the
 * local card, sorted for Router worker acquisition.
 */
const recoverPinnedSenderCards = (
  environment: ProtocolEnvironment,
  localAgentCard: VerifiedAgentCard,
): Effect.Effect<readonly VerifiedAgentCard[], DaemonActivationError> =>
  Effect.gen(function* () {
    const recovery = yield* environment.store
      .recover()
      .pipe(Effect.mapError(() => activationFailure("persistence")));
    const pinned: PinnedCards = {
      cards: new Map(),
      representations: new Map(),
    };
    yield* retainPinnedCard(pinned, localAgentCard);
    yield* Effect.forEach(
      recovery.memberships,
      (stored) =>
        retainMembershipCards(
          { bootstrap: environment.bootstrap, pinned },
          stored,
        ),
      { concurrency: 1, discard: true },
    );
    return [...pinned.cards.values()].sort((left, right) =>
      compareAscii(left.agentId, right.agentId),
    );
  }).pipe(Effect.withSpan("recoverPinnedSenderCards"));

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

const signStructurallyValidAction: EndpointEngineInput["actionPolicy"] = () =>
  Effect.succeed("sign");

const mapWorkerInitializationError = (
  error: RouterWorkerTransportError | RouterWorkerProtocolError,
): DaemonActivationError =>
  activationFailure(
    error._tag === "RouterWorkerTransportError" ? "upstream" : "representation",
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

const acquireProtocolWorker = (input: {
  readonly environment: ProtocolEnvironment;
  readonly agentCard: VerifiedAgentCard;
  readonly pinnedSenderCards: readonly VerifiedAgentCard[];
  readonly awaitEngine: Effect.Effect<EndpointEngine>;
  readonly publishPending: Effect.Effect<void>;
}) =>
  input.environment.edges
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
  environment.edges
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

/**
 * The collective layer for the active identity: it certifies posts through
 * the engine and hands the items it emits to the daemon.
 */
const makeProtocolCollectives = (
  environment: ProtocolEnvironment,
  emit: ProtocolHooks["emit"],
  agentCard: VerifiedAgentCard,
  engine: EndpointEngine,
): CollectiveOperations =>
  makeCollectiveOperations({
    self: Schema.decodeUnknownSync(AgentAddress)(
      `agent:${agentCard.agentName}`,
    ),
    lookupMember: (member) => engine.resolveAddress(member),
    sendPost: (input) => engine.send(input),
    emit,
    scope: environment.daemonScope,
  });

/**
 * Acquire and supervise the protocol resources for one immutable daemon
 * identity. The protocol reaches `hooks.retain` before the worker's callbacks
 * can reach the engine, so a delivery pass a callback starts already sees it.
 * @param environment Daemon-owned dependencies and resource scope.
 * @param hooks Where the protocol is held and where its ingress is published.
 * @param agentCard Verified local identity to activate.
 * @returns Completion after engine and worker fibers are running.
 */
export const acquireProtocol = (
  environment: ProtocolEnvironment,
  hooks: ProtocolHooks,
  agentCard: VerifiedAgentCard,
): Effect.Effect<void, DaemonActivationError> =>
  Effect.gen(function* () {
    const pinnedSenderCards = yield* recoverPinnedSenderCards(
      environment,
      agentCard,
    );
    const engineReady = yield* Deferred.make<EndpointEngine>();
    const worker = yield* acquireProtocolWorker({
      environment,
      agentCard,
      pinnedSenderCards,
      awaitEngine: Deferred.await(engineReady),
      publishPending: hooks.publishPending,
    });
    const engine = yield* acquireProtocolEngine(environment, agentCard, worker);
    hooks.retain({
      agentCard,
      worker,
      engine,
      collectives: makeProtocolCollectives(
        environment,
        hooks.emit,
        agentCard,
        engine,
      ),
    });
    yield* Deferred.succeed(engineReady, engine);
    yield* superviseBackground(environment, worker.run);
    yield* superviseBackground(environment, engine.runOutbound);
  }).pipe(Effect.withSpan("acquireProtocol"));
