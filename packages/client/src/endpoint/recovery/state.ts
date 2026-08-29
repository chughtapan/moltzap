/** @file Shared volatile state for catch-up and Router re-anchor runs. */

import {
  type AgentId,
  MOLTZAP_VERSION,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Deferred, Effect, Queue, Schema } from "effect";
import type { EngineRuntime } from "../engine-types.js";
import type { EndpointRecovery } from "../store.js";
import {
  AnchorHash,
  type AnchorHash as AnchorHashValue,
  CatchUpRequest,
  type CatchUpRequest as CatchUpRequestValue,
  type ConversationId as ConversationIdValue,
  decodeCanonical,
  type DirectPacket,
  encodeCanonical,
  memberCard,
  MembershipDescriptor,
  type ReanchorVoteStatement as ReanchorVoteStatementValue,
  RecordHash,
  type RecordHash as RecordHashValue,
  signOuterEvidence,
  signOuterPacket,
  type VerifiedMembership,
  verifyMembershipDescriptor,
} from "../representation.js";
import {
  RouterWorkerPersistenceError,
  type RouterWorkerRecovery,
  RouterWorkerRecoveryError,
  type RouterWorkerRecoverySend,
} from "../router-worker/index.js";

/** Mutable state scoped to one authenticated catch-up and re-anchor run. */
export interface ActiveRecoveryState {
  readonly recovery: RouterWorkerRecovery;
  readonly outbound: Queue.Queue<RouterWorkerRecoverySend>;
  readonly completion: Deferred.Deferred<undefined, RouterWorkerRecoveryError>;
  readonly memberships: Map<ConversationIdValue, VerifiedMembership>;
  readonly pendingRequests: Map<ConversationIdValue, CatchUpRequestValue>;
  readonly incompleteResponders: Map<ConversationIdValue, Set<AgentId>>;
  readonly acceptedSuccessors: Map<string, RecordHashValue | AnchorHashValue>;
  readonly observedHeads: Map<ConversationIdValue, Set<RecordHashValue>>;
  readonly pendingVotes: Map<
    ConversationIdValue,
    Map<AnchorHashValue, Map<AgentId, PendingReanchorVote>>
  >;
  readonly positionsReady: Set<ConversationIdValue>;
  readonly completedConversations: Set<ConversationIdValue>;
  pendingOutbound: number;
}

/** One verified re-anchor vote retained until its ancestry is resolved. */
export interface PendingReanchorVote {
  readonly message: SignedMessageValue;
  readonly statement: ReanchorVoteStatementValue;
}

const activeRecoveries = new WeakMap<EngineRuntime, ActiveRecoveryState>();

/**
 * Resolve the latest durable position for one fixed conversation.
 * @param runtime Engine whose endpoint store owns the conversation.
 * @param conversationId Private conversation identity to locate.
 * @returns The complete recovery snapshot and its matching position row.
 */
export const durablePosition = (
  runtime: EngineRuntime,
  conversationId: ConversationIdValue,
) =>
  runtime.input.store.recover().pipe(
    Effect.mapError(persistenceFailure),
    Effect.map((recovery) => ({
      recovery,
      position: recovery.positions.find(
        (candidate) => candidate.conversationId === conversationId,
      ),
    })),
  );

/**
 * Queue a signed catch-up request at the engine's current durable position.
 * @param runtime Engine participating in active recovery.
 * @param conversationId Private conversation identity to reconcile.
 * @returns Completion after the request is stored in the recovery queue.
 */
export const requestCertifiedHistory = (
  runtime: EngineRuntime,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const state = currentRecoveryState(runtime);
    const membership = state?.memberships.get(conversationId);
    if (state === undefined || membership === undefined) {
      return yield* Effect.fail(persistenceFailure());
    }
    const { position } = yield* durablePosition(runtime, conversationId);
    if (position === undefined) {
      return yield* Effect.fail(persistenceFailure());
    }
    const knownRecordHash = yield* decodeKnownRecordHash(position);
    const knownAnchorHash = yield* decodeKnownAnchorHash(position);
    const request = yield* makeCatchUpRequest(
      runtime,
      membership,
      knownRecordHash,
      knownAnchorHash,
    );
    yield* Effect.sync(() => {
      state.pendingRequests.set(conversationId, request);
      state.incompleteResponders.set(conversationId, new Set<AgentId>());
    });
    yield* queueRecoveryPacket(runtime, membership, request);
  }).pipe(Effect.withSpan("requestCertifiedHistory"));

/**
 * Queue one signed recovery packet for all fixed members.
 * @param runtime Engine whose recovery queue owns the packet.
 * @param membership Verified fixed membership for the outer envelope.
 * @param packet Closed recovery packet to route.
 * @returns Completion after the outer envelope enters the durable queue.
 */
export function queueRecoveryPacket(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  packet: DirectPacket,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return signOuterPacket({
    packet,
    membership,
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((message) =>
      enqueueOuter(runtime, membership.descriptor.conversationId, message),
    ),
  );
}

/**
 * Queue one stable inner evidence message for all fixed members.
 * @param runtime Engine whose recovery queue owns the evidence.
 * @param membership Verified fixed membership for the outer envelope.
 * @param evidence Stable self-addressed evidence to relay.
 * @returns Completion after the outer envelope enters the durable queue.
 */
export function queueRecoveryEvidence(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  evidence: SignedMessageValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return signOuterEvidence({
    evidence,
    membership,
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((message) =>
      enqueueOuter(runtime, membership.descriptor.conversationId, message),
    ),
  );
}

/**
 * Mark one fixed conversation reconciled and complete an idle recovery run.
 * @param runtime Engine participating in active recovery.
 * @param conversationId Conversation whose verified position is complete.
 * @returns Completion after any newly idle run is released.
 */
export function markConversationRecovered(
  runtime: EngineRuntime,
  conversationId: ConversationIdValue,
): Effect.Effect<void> {
  const state = currentRecoveryState(runtime);
  if (state === undefined) {
    return Effect.void;
  }
  return Effect.sync(() => {
    state.completedConversations.add(conversationId);
  }).pipe(Effect.zipRight(completeRecoveryIfIdle(state)));
}

/**
 * Validate every stored fixed membership against current engine state.
 * @param runtime Engine whose recovered conversations are authoritative.
 * @param recovery Store snapshot to validate.
 * @returns One unique verified membership per recovered conversation.
 */
export function recoverMemberships(
  runtime: EngineRuntime,
  recovery: EndpointRecovery,
): Effect.Effect<
  Map<ConversationIdValue, VerifiedMembership>,
  RouterWorkerRecoveryError
> {
  return Effect.forEach(
    recovery.memberships,
    (stored) => recoverMembership(runtime, stored),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap((entries) => uniqueMembershipMap(entries)),
    Effect.withSpan("recoverMemberships"),
  );
}

/**
 * Determine whether one observed record belongs to the retained head ancestry.
 * @param recovery Complete verified recovery snapshot.
 * @param conversationId Conversation whose record chain is examined.
 * @param observed Record hash reported by a fixed member.
 * @param head Locally retained certified head.
 * @returns Whether the observed record is the head or one of its ancestors.
 */
export function observedHeadIsResolved(
  recovery: EndpointRecovery,
  conversationId: ConversationIdValue,
  observed: RecordHashValue,
  head: RecordHashValue,
): boolean {
  let cursor: string | undefined = head;
  while (cursor !== undefined) {
    if (cursor === observed) {
      return true;
    }
    cursor = previousRecordHash(recovery, conversationId, cursor);
  }
  return false;
}

/**
 * Determine whether one observed anchor belongs to the retained anchor chain.
 * @param recovery Complete verified recovery snapshot.
 * @param conversationId Conversation whose anchor chain is examined.
 * @param observed Anchor hash reported by a fixed member.
 * @param current Locally retained current anchor.
 * @returns Whether the observed anchor is current or one of its ancestors.
 */
export function observedAnchorIsResolved(
  recovery: EndpointRecovery,
  conversationId: ConversationIdValue,
  observed: AnchorHashValue,
  current: AnchorHashValue,
): boolean {
  let cursor: string | undefined = current;
  while (cursor !== undefined) {
    if (cursor === observed) {
      return true;
    }
    cursor = previousAnchorHash(recovery, conversationId, cursor);
  }
  return false;
}

/**
 * Allocate all volatile state for one bounded recovery session.
 * @param recovery RouterWorker callbacks and discontinuity anchor.
 * @param memberships Verified memberships that must be reconciled.
 * @returns Fresh queues, indexes, and completion signal for the run.
 */
export const makeRecoveryState = (
  recovery: RouterWorkerRecovery,
  memberships: Map<ConversationIdValue, VerifiedMembership>,
): Effect.Effect<ActiveRecoveryState> =>
  Effect.gen(function* () {
    return {
      recovery,
      outbound: yield* Queue.unbounded<RouterWorkerRecoverySend>(),
      completion: yield* Deferred.make<undefined, RouterWorkerRecoveryError>(),
      memberships,
      pendingRequests: new Map<ConversationIdValue, CatchUpRequestValue>(),
      incompleteResponders: new Map<ConversationIdValue, Set<AgentId>>(),
      acceptedSuccessors: new Map<string, RecordHashValue | AnchorHashValue>(),
      observedHeads: new Map<ConversationIdValue, Set<RecordHashValue>>(),
      pendingVotes: new Map<
        ConversationIdValue,
        Map<AnchorHashValue, Map<AgentId, PendingReanchorVote>>
      >(),
      positionsReady: new Set<ConversationIdValue>(),
      completedConversations: new Set<ConversationIdValue>(),
      pendingOutbound: 0,
    };
  }).pipe(Effect.withSpan("makeRecoveryState"));

/**
 * Account for one sent recovery envelope and release an idle run.
 * @param state Active recovery session whose envelope committed.
 * @returns Completion after the pending count and waiter are updated.
 */
export function outboundCommitted(
  state: ActiveRecoveryState,
): Effect.Effect<void> {
  return Effect.sync(() => {
    state.pendingOutbound -= 1;
  }).pipe(Effect.zipRight(completeRecoveryIfIdle(state)));
}

/**
 * Release a recovery run whose conversations and outbound queue are complete.
 * @param state Active recovery session to examine.
 * @returns Completion after the session waiter is released when idle.
 */
export function completeRecoveryIfIdle(
  state: ActiveRecoveryState,
): Effect.Effect<void> {
  return Effect.suspend(() =>
    recoveryIsIdle(state)
      ? Deferred.succeed(state.completion, undefined).pipe(Effect.asVoid)
      : Effect.void,
  );
}

/**
 * Return the active recovery owned by an engine, when one exists.
 * @param runtime Engine whose recovery state is requested.
 * @returns The active run, or `undefined` while the engine is not recovering.
 */
export function currentRecoveryState(
  runtime: EngineRuntime,
): ActiveRecoveryState | undefined {
  return activeRecoveries.get(runtime);
}

/**
 * Install the only active recovery for an engine.
 * @param runtime Engine beginning a recovery run.
 * @param state Volatile state owned by that run.
 */
export function installRecoveryState(
  runtime: EngineRuntime,
  state: ActiveRecoveryState,
): void {
  activeRecoveries.set(runtime, state);
}

/**
 * Clear an engine recovery only when it still owns the supplied state.
 * @param runtime Engine completing or aborting recovery.
 * @param state Run that must still be active before removal.
 */
export function clearRecoveryState(
  runtime: EngineRuntime,
  state: ActiveRecoveryState,
): void {
  if (activeRecoveries.get(runtime) === state) {
    activeRecoveries.delete(runtime);
  }
}

function recoveryIsIdle(state: ActiveRecoveryState): boolean {
  return (
    state.completedConversations.size === state.memberships.size &&
    state.pendingOutbound === 0
  );
}

function enqueueOuter(
  runtime: EngineRuntime,
  conversationId: ConversationIdValue,
  message: SignedMessageValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const state = currentRecoveryState(runtime);
  if (state !== undefined) {
    return Effect.sync(() => {
      state.pendingOutbound += 1;
    }).pipe(
      Effect.zipRight(Queue.offer(state.outbound, { conversationId, message })),
      Effect.asVoid,
    );
  }
  return encodeCanonical(SignedMessage, message).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((canonicalSignedMessage) =>
      runtime.input.store.enqueueOutbound({
        conversationId,
        messageId: message.messageId,
        canonicalSignedMessage,
      }),
    ),
    Effect.mapError(persistenceFailure),
    Effect.flatMap((outbound) =>
      Effect.sync(() => {
        if (!runtime.outbound.includes(outbound.outboundId)) {
          runtime.outbound.push(outbound.outboundId);
        }
      }),
    ),
    Effect.zipRight(runtime.outboundSignal.offer(undefined)),
    Effect.asVoid,
  );
}

function makeCatchUpRequest(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  knownRecordHash: RecordHashValue | null,
  knownAnchorHash: AnchorHashValue | null,
): Effect.Effect<CatchUpRequestValue, RouterWorkerPersistenceError> {
  return Schema.decodeUnknown(CatchUpRequest)({
    moltzapVersion: MOLTZAP_VERSION,
    kind: "catch_up_request",
    conversationId: membership.descriptor.conversationId,
    membershipHash: membership.hash,
    requesterAgentId: runtime.input.localAgentCard.agentId,
    knownRecordHash,
    knownAnchorHash,
  }).pipe(Effect.mapError(persistenceFailure));
}

function decodeKnownRecordHash(
  position: EndpointRecovery["positions"][number],
): Effect.Effect<RecordHashValue | null, RouterWorkerPersistenceError> {
  if (position.headRecordHash === undefined) {
    return Effect.succeed(null);
  }
  return Schema.decodeUnknown(RecordHash)(position.headRecordHash).pipe(
    Effect.mapError(persistenceFailure),
  );
}

function decodeKnownAnchorHash(
  position: EndpointRecovery["positions"][number],
): Effect.Effect<AnchorHashValue | null, RouterWorkerPersistenceError> {
  if (position.headRecordHash === undefined) {
    return Effect.succeed(null);
  }
  return Schema.decodeUnknown(AnchorHash)(position.currentAnchorHash).pipe(
    Effect.mapError(persistenceFailure),
  );
}

function recoverMembership(
  runtime: EngineRuntime,
  stored: EndpointRecovery["memberships"][number],
): Effect.Effect<
  readonly [ConversationIdValue, VerifiedMembership],
  RouterWorkerRecoveryError
> {
  return decodeCanonical(MembershipDescriptor, stored.canonicalMembership).pipe(
    Effect.flatMap((descriptor) =>
      verifyMembershipDescriptor(
        descriptor,
        runtime.input.registrySignerPublicKey,
      ),
    ),
    Effect.flatMap((membership) => {
      if (!recoveredMembershipMatches(runtime, stored, membership)) {
        return Effect.fail(recoveryFailure());
      }
      const entry: readonly [ConversationIdValue, VerifiedMembership] = [
        membership.descriptor.conversationId,
        membership,
      ];
      return Effect.succeed(entry);
    }),
    Effect.mapError(recoveryFailure),
  );
}

function recoveredMembershipMatches(
  runtime: EngineRuntime,
  stored: EndpointRecovery["memberships"][number],
  membership: VerifiedMembership,
): boolean {
  const conversationId = membership.descriptor.conversationId;
  const retained = runtime.conversations.get(conversationId);
  return [
    conversationId === stored.conversationId,
    membership.hash === stored.membershipHash,
    memberCard(membership, runtime.input.localAgentCard.agentId) !== undefined,
    retained?.membership.hash === membership.hash,
  ].every((matches) => matches);
}

function uniqueMembershipMap(
  entries: ReadonlyArray<readonly [ConversationIdValue, VerifiedMembership]>,
): Effect.Effect<
  Map<ConversationIdValue, VerifiedMembership>,
  RouterWorkerRecoveryError
> {
  const memberships = new Map<ConversationIdValue, VerifiedMembership>(entries);
  return memberships.size === entries.length
    ? Effect.succeed(memberships)
    : Effect.fail(recoveryFailure());
}

function previousRecordHash(
  recovery: EndpointRecovery,
  conversationId: ConversationIdValue,
  recordHash: string,
): string | undefined {
  for (const candidate of recovery.certifiedRecords) {
    if (
      candidate.conversationId === conversationId &&
      candidate.recordHash === recordHash
    ) {
      return candidate.previousRecordHash;
    }
  }
  return undefined;
}

function previousAnchorHash(
  recovery: EndpointRecovery,
  conversationId: ConversationIdValue,
  anchorHash: string,
): string | undefined {
  for (const candidate of recovery.anchors) {
    if (
      candidate.conversationId === conversationId &&
      candidate.anchorHash === anchorHash
    ) {
      return candidate.previousAnchorHash;
    }
  }
  return undefined;
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}

function recoveryFailure(): RouterWorkerRecoveryError {
  return new RouterWorkerRecoveryError();
}
