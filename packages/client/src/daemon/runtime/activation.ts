/** @file Private daemon activation, recovery, and registration preparation. */

import type { Registry } from "@moltzap/identity/registry";
import type { Router } from "@moltzap/router";
import {
  AgentCard,
  type AgentId,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { Data, Deferred, Effect, type Scope } from "effect";
import type {
  EndpointEngine,
  EndpointEngineInput,
  EngineInitializationError,
} from "../../endpoint/engine.js";
import type {
  RouterWorker,
  RouterWorkerInput,
  RouterWorkerProtocolError,
  RouterWorkerTransportError,
} from "../../endpoint/router-worker/index.js";
import type { EndpointStore, StoredMembership } from "../../endpoint/store.js";
import type { HarnessMessageReadyEvent } from "../../harness-mcp-contract.js";
import type { HarnessMcpSubscriptionHandler } from "../../harness-mcp-subscription.js";
import type { makeHarnessMcpHttpHandler } from "../../harness-mcp-wire.js";
import type { DaemonBootstrap } from "../configuration.js";
import {
  decodeCanonical,
  encodeCanonical,
  MembershipDescriptor,
  verifyMembershipDescriptor,
} from "../../endpoint/representation.js";
import {
  type DaemonManagementOperations,
  makeDaemonManagementOperations,
} from "../management.js";
import {
  type DaemonRegistrationState,
  readDaemonRegistrationState,
} from "../registration.js";

type SubscriptionHandler =
  HarnessMcpSubscriptionHandler<HarnessMessageReadyEvent>;

/** Closed private daemon failure projected onto the public startup phases. */
export class DaemonRuntimeError extends Data.TaggedError("DaemonRuntimeError")<{
  readonly phase: "storage" | "listener";
}> {}

/** Closed activation failure retained behind the daemon runtime boundary. */
export class DaemonActivationError extends Data.TaggedError(
  "DaemonActivationError",
)<{
  readonly reason: "upstream" | "persistence" | "representation";
}> {}

/** Replaceable process edges used only by focused lifecycle tests. */
export interface DaemonRuntimeDependencies {
  readonly makeWorker: (
    input: RouterWorkerInput,
  ) => Effect.Effect<
    RouterWorker,
    RouterWorkerTransportError | RouterWorkerProtocolError,
    Registry | Router
  >;
  readonly makeEngine: (
    input: EndpointEngineInput,
  ) => Effect.Effect<EndpointEngine, EngineInitializationError, Scope.Scope>;
  readonly makeHandler: typeof makeHarnessMcpHttpHandler;
  readonly acquireListener: (input: {
    readonly port: number;
    readonly handler: SubscriptionHandler;
  }) => Effect.Effect<void, Error, Scope.Scope>;
}

/** Management and durable identity state acquired before protocol startup. */
export interface DaemonActivationPreparation {
  readonly management: DaemonManagementOperations;
  readonly registration: DaemonRegistrationState;
}

/** Protocol initializer serialized by the daemon controller. */
export type InitializeProtocol = (
  agentCard: VerifiedAgentCard,
) => Effect.Effect<void, DaemonActivationError>;

/** Completed management registration result passed through after activation. */
export type RegistrationResult = Effect.Effect.Success<
  ReturnType<DaemonManagementOperations["register"]>
>;

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

const activationFailure = (
  reason: DaemonActivationError["reason"],
): DaemonActivationError => new DaemonActivationError({ reason });

const runtimeFailure = (
  phase: DaemonRuntimeError["phase"],
): DaemonRuntimeError => new DaemonRuntimeError({ phase });

const activationRuntimeFailure = (
  error: DaemonActivationError,
): DaemonRuntimeError =>
  runtimeFailure(error.reason === "upstream" ? "listener" : "storage");

const encodeCard = (
  card: VerifiedAgentCard,
): Effect.Effect<Uint8Array, DaemonActivationError> =>
  encodeCanonical(AgentCard, card).pipe(
    Effect.mapError(() => activationFailure("representation")),
  );

interface PinnedCards {
  readonly cards: Map<AgentId, VerifiedAgentCard>;
  readonly representations: Map<AgentId, Uint8Array>;
}

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

const compareAgentCards = (
  left: VerifiedAgentCard,
  right: VerifiedAgentCard,
): number => {
  if (left.agentId === right.agentId) {
    return 0;
  }
  return left.agentId < right.agentId ? -1 : 1;
};

/**
 * Recover the unique canonical sender cards pinned by durable memberships.
 * @param input Durable store, configured Registry authority, and local card.
 * @param input.store Durable endpoint state containing recovered memberships.
 * @param input.localAgentCard Verified card configured for this daemon.
 * @param input.bootstrap Fixed Registry authority used to verify memberships.
 * @returns Canonically sorted cards ready for Router worker acquisition.
 */
export const recoverPinnedSenderCards = (input: {
  readonly store: EndpointStore;
  readonly localAgentCard: VerifiedAgentCard;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<readonly VerifiedAgentCard[], DaemonActivationError> =>
  Effect.gen(function* () {
    const recovery = yield* input.store
      .recover()
      .pipe(Effect.mapError(() => activationFailure("persistence")));
    const pinned: PinnedCards = {
      cards: new Map(),
      representations: new Map(),
    };
    yield* retainPinnedCard(pinned, input.localAgentCard);
    yield* Effect.forEach(
      recovery.memberships,
      (stored) =>
        retainMembershipCards({ bootstrap: input.bootstrap, pinned }, stored),
      { concurrency: 1, discard: true },
    );
    return [...pinned.cards.values()].sort(compareAgentCards);
  }).pipe(Effect.withSpan("recoverPinnedSenderCards"));

const initializeRegistrationState = (
  initialize: InitializeProtocol,
  state: DaemonRegistrationState,
): Effect.Effect<void, DaemonActivationError> => {
  if (state.kind !== "active") {
    return Effect.fail(activationFailure("persistence"));
  }
  return initialize(state.agentCard);
};

/**
 * Complete activation after a successful management registration.
 * @param input Durable identity dependencies, fatal channel, and initializer.
 * @param input.store Durable endpoint identity state.
 * @param input.bootstrap Fixed Registry and signing authority.
 * @param input.fatal Daemon-wide supervised failure channel.
 * @param input.initialize Serialized protocol initializer.
 * @param result Closed management registration result to pass through.
 * @returns The original result after any required protocol activation.
 */
export const finishRegistration = (
  input: {
    readonly store: EndpointStore;
    readonly bootstrap: DaemonBootstrap;
    readonly fatal: Deferred.Deferred<never, DaemonRuntimeError>;
    readonly initialize: InitializeProtocol;
  },
  result: RegistrationResult,
): Effect.Effect<RegistrationResult, DaemonActivationError> => {
  if (result.kind !== "registered") {
    return Effect.succeed(result);
  }
  return readDaemonRegistrationState(input).pipe(
    Effect.mapError((error) =>
      activationFailure(
        error._tag === "DaemonRegistrationPersistenceError"
          ? "persistence"
          : "representation",
      ),
    ),
    Effect.flatMap((state) =>
      initializeRegistrationState(input.initialize, state),
    ),
    Effect.tapError((error) =>
      Deferred.fail(input.fatal, activationRuntimeFailure(error)),
    ),
    Effect.as(result),
  );
};

/**
 * Acquire management operations and the verified durable startup identity.
 * @param input Daemon-owned persistence and fixed endpoint configuration.
 * @param input.store Durable endpoint identity state.
 * @param input.bootstrap Fixed Registry and signing authority.
 * @returns Management operations paired with the current registration state.
 */
export const prepareDaemonActivation = (input: {
  readonly store: EndpointStore;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<DaemonActivationPreparation, DaemonRuntimeError, Registry> =>
  Effect.gen(function* () {
    const management = yield* makeDaemonManagementOperations(input);
    const registration = yield* readDaemonRegistrationState(input).pipe(
      Effect.mapError(() => runtimeFailure("storage")),
    );
    return { management, registration };
  }).pipe(Effect.withSpan("prepareDaemonActivation"));
