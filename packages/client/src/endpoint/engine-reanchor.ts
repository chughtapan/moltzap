/** @file Router-restart head reconciliation and threshold re-anchoring. */

import {
  type AgentId,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Deferred, Effect, Fiber, Queue, Schema } from "effect";
import type { ConversationId } from "../contract.js";
import type { EngineRuntime } from "./engine-types.js";
import type { EndpointRecovery } from "./store.js";
import {
  acceptCatchUpPacket,
  completeEngineRecoveryIfIdle,
  engineRecoveryState,
  type EngineRecoveryState,
  installEngineRecoveryState,
  recoverMemberships,
  removeEngineRecoveryState,
  requestCertifiedHistory,
} from "./engine-catch-up.js";
import {
  AnchorHash,
  compareAgentIds,
  CompletedReanchor,
  type CompletedReanchor as CompletedReanchorValue,
  decodeCanonical,
  type DecodedOuterBody,
  durabilityThreshold,
  encodeCanonical,
  EvidenceStatement,
  type EvidenceStatement as EvidenceStatementValue,
  hashAnchor,
  ReanchorBody,
  type ReanchorBody as ReanchorBodyValue,
  RecordHash,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
  type VerifiedMembership,
  verifyCompletedReanchor,
  verifyOuterMessage,
  verifyStableEvidence,
} from "./representation.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
  type RouterWorkerRecovery,
  RouterWorkerRecoveryError,
  type RouterWorkerSendError,
} from "./router-worker.js";

const accepted: RouterIngressDisposition = "accepted";
const ignored: RouterIngressDisposition = "ignored";
const persistenceFailure = (): RouterWorkerPersistenceError =>
  new RouterWorkerPersistenceError();
const recoveryFailure = (): RouterWorkerRecoveryError =>
  new RouterWorkerRecoveryError();

interface PendingVote {
  readonly message: SignedMessageValue;
  readonly statement: Extract<
    EvidenceStatementValue,
    { readonly kind: "reanchor_vote" }
  >;
}

interface VotePersistence {
  readonly body: ReanchorBodyValue;
  readonly anchorHash: string;
  readonly message: SignedMessageValue;
  readonly signerAgentId: AgentId;
}

interface CandidatePositionInput {
  readonly state?: EngineRecoveryState;
  readonly position?: EndpointRecovery["positions"][number];
  readonly membership: VerifiedMembership;
  readonly body: ReanchorBodyValue;
}

const pendingVotes = new WeakMap<
  EngineRuntime,
  Map<ConversationId, Map<string, PendingVote[]>>
>();

const recoveryQueue = (
  runtime: EngineRuntime,
  message: SignedMessageValue,
): Effect.Effect<void, RouterWorkerPersistenceError> => {
  const state = engineRecoveryState(runtime);
  if (state === undefined) {
    return Effect.fail(persistenceFailure());
  }
  state.pendingOutbound += 1;
  return Queue.offer(state.outbound, message).pipe(Effect.asVoid);
};

const queueEvidence = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  evidence: SignedMessageValue,
) =>
  signOuterEvidence({
    evidence,
    membership,
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((message) => recoveryQueue(runtime, message)),
  );

const queueCompleted = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  completed: CompletedReanchorValue,
) =>
  signOuterPacket({
    packet: completed,
    membership,
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((message) => recoveryQueue(runtime, message)),
  );

const markComplete = (
  runtime: EngineRuntime,
  conversationId: ConversationId,
): Effect.Effect<void> => {
  const state = engineRecoveryState(runtime);
  if (state === undefined) {
    return Effect.void;
  }
  state.completedConversations.add(conversationId);
  return completeEngineRecoveryIfIdle(state);
};

const durablePosition = (
  runtime: EngineRuntime,
  conversationId: ConversationId,
) =>
  runtime.input.store.recover().pipe(
    Effect.mapError(persistenceFailure),
    Effect.map((recovery) => ({
      recovery,
      position: recovery.positions.find(
        (item) => item.conversationId === conversationId,
      ),
    })),
  );

const sameSelection = (left: ReanchorBodyValue, right: ReanchorBodyValue) =>
  left.previousAnchorHash === right.previousAnchorHash &&
  left.selectedRecordHash === right.selectedRecordHash;

const sameBody = (left: ReanchorBodyValue, right: ReanchorBodyValue) =>
  left.conversationId === right.conversationId &&
  left.membershipHash === right.membershipHash &&
  sameSelection(left, right) &&
  left.routerInstanceId === right.routerInstanceId;

const matchesCandidatePosition = ({
  state,
  position,
  membership,
  body,
}: CandidatePositionInput): boolean => {
  if (
    state === undefined ||
    state.recovery.reason !== "router_restarted" ||
    position?.headRecordHash === undefined
  ) {
    return false;
  }
  const matchesDurableHead =
    body.previousAnchorHash === position.currentAnchorHash &&
    body.selectedRecordHash === position.headRecordHash;
  return (
    body.membershipHash === membership.hash &&
    matchesDurableHead &&
    body.routerInstanceId === state.recovery.anchor.routerInstanceId
  );
};

const stageExactCandidate = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: CompletedReanchorValue["anchorHash"],
): Effect.Effect<boolean, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const state = engineRecoveryState(runtime);
    const { recovery, position } = yield* durablePosition(
      runtime,
      body.conversationId,
    );
    if (!matchesCandidatePosition({ state, position, membership, body })) {
      return false;
    }
    const existing = recovery.stagedReanchors.find(
      (item) =>
        item.conversationId === body.conversationId &&
        item.previousAnchorHash === body.previousAnchorHash &&
        item.routerInstanceId === body.routerInstanceId,
    );
    if (existing !== undefined && existing.anchorHash !== anchorHash) {
      return false;
    }
    yield* runtime.input.store.stageReanchor({
      conversationId: body.conversationId,
      anchorHash,
      previousAnchorHash: body.previousAnchorHash,
      routerInstanceId: body.routerInstanceId,
      selectedRecordHash: body.selectedRecordHash,
      canonicalBody: yield* encodeCanonical(ReanchorBody, body),
    });
    return true;
  }).pipe(Effect.mapError(persistenceFailure));

const persistVote = (runtime: EngineRuntime, input: VotePersistence) =>
  encodeCanonical(SignedMessage, input.message).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((canonicalEvidence) =>
      runtime.input.store.mergeEvidence({
        conversationId: input.body.conversationId,
        kind: "reanchor",
        subjectId: input.anchorHash,
        evidenceKey: input.signerAgentId,
        canonicalEvidence,
      }),
    ),
    Effect.mapError(persistenceFailure),
    Effect.asVoid,
  );

const decodeRetainedVotes = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: string,
): Effect.Effect<readonly SignedMessageValue[], RouterWorkerPersistenceError> =>
  runtime.input.store.recover().pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((recovery) =>
      Effect.forEach(
        recovery.evidence.filter(
          (item) =>
            item.kind === "reanchor" &&
            item.conversationId === body.conversationId &&
            item.subjectId === anchorHash,
        ),
        (item) =>
          Effect.gen(function* () {
            const message = yield* decodeCanonical(
              SignedMessage,
              item.canonicalEvidence,
            );
            const representation = yield* Schema.encode(SignedMessage)(message);
            const verified = yield* verifyStableEvidence({
              representation,
              membership,
            });
            if (
              verified.statement.kind !== "reanchor_vote" ||
              verified.statement.anchorHash !== anchorHash ||
              !sameBody(verified.statement.reanchor, body)
            ) {
              return yield* persistenceFailure();
            }
            return verified.message;
          }).pipe(Effect.mapError(persistenceFailure)),
        { concurrency: 1 },
      ),
    ),
  );

const ensureLocalVote = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHash,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const votes = yield* decodeRetainedVotes(
      runtime,
      membership,
      body,
      anchorHash,
    );
    const retained = votes.find(
      (message) =>
        message.senderAgentId === runtime.input.localAgentCard.agentId,
    );
    if (retained !== undefined) {
      return;
    }
    const local = yield* signEvidenceMessage({
      statement: {
        moltzapVersion: body.moltzapVersion,
        kind: "reanchor_vote",
        signerAgentId: runtime.input.localAgentCard.agentId,
        anchorHash,
        reanchor: body,
      },
      agentCard: runtime.input.localAgentCard,
      signingAuthority: runtime.input.signingAuthority,
    }).pipe(Effect.mapError(persistenceFailure));
    yield* persistVote(runtime, {
      body,
      anchorHash,
      message: local,
      signerAgentId: runtime.input.localAgentCard.agentId,
    });
    yield* queueEvidence(runtime, membership, local);
  }).pipe(Effect.mapError(persistenceFailure));

const persistCompleted = (
  runtime: EngineRuntime,
  body: ReanchorBodyValue,
  completed: CompletedReanchorValue,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    yield* runtime.input.store.completeReanchor({
      conversationId: body.conversationId,
      anchorHash: completed.anchorHash,
      previousAnchorHash: body.previousAnchorHash,
      routerInstanceId: body.routerInstanceId,
      selectedRecordHash: body.selectedRecordHash,
      canonicalBody: yield* encodeCanonical(ReanchorBody, body),
      canonicalCompletedReanchor: yield* encodeCanonical(
        CompletedReanchor,
        completed,
      ),
    });
    const conversation = runtime.conversations.get(body.conversationId);
    if (conversation !== undefined) {
      conversation.currentAnchor = completed;
    }
  }).pipe(Effect.mapError(persistenceFailure));

const completeIfThreshold = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHash,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const votes = [
      ...(yield* decodeRetainedVotes(runtime, membership, body, anchorHash)),
    ].sort((left, right) =>
      compareAgentIds(left.senderAgentId, right.senderAgentId),
    );
    if (votes.length < durabilityThreshold(membership.members.length)) {
      return;
    }
    const encoded = yield* Effect.forEach(
      votes,
      (message) => Schema.encode(SignedMessage)(message),
      { concurrency: 1 },
    ).pipe(Effect.mapError(persistenceFailure));
    const first = encoded[0];
    if (first === undefined) {
      return yield* persistenceFailure();
    }
    const completed: CompletedReanchorValue = {
      moltzapVersion: body.moltzapVersion,
      kind: "completed_reanchor",
      anchorHash,
      reanchor: body,
      votes: [first, ...encoded.slice(1)],
    };
    yield* verifyCompletedReanchor({ completed, membership }).pipe(
      Effect.mapError(persistenceFailure),
    );
    yield* persistCompleted(runtime, body, completed);
    yield* queueCompleted(runtime, membership, completed);
    yield* markComplete(runtime, body.conversationId);
  }).pipe(Effect.mapError(persistenceFailure));

const rememberVote = (runtime: EngineRuntime, vote: PendingVote): void => {
  const conversations =
    pendingVotes.get(runtime) ??
    new Map<ConversationId, Map<string, PendingVote[]>>();
  pendingVotes.set(runtime, conversations);
  const candidates =
    conversations.get(vote.statement.reanchor.conversationId) ??
    new Map<string, PendingVote[]>();
  conversations.set(vote.statement.reanchor.conversationId, candidates);
  const retained = candidates.get(vote.statement.anchorHash) ?? [];
  if (
    !retained.some(
      (item: PendingVote) =>
        item.statement.signerAgentId === vote.statement.signerAgentId,
    )
  ) {
    retained.push(vote);
  }
  candidates.set(vote.statement.anchorHash, retained);
};

const processVerifiedVote = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  vote: PendingVote,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const { anchorHash, reanchor: body, signerAgentId } = vote.statement;
    const expectedHash = yield* hashAnchor(body).pipe(
      Effect.mapError(persistenceFailure),
    );
    if (expectedHash !== anchorHash) {
      return;
    }
    const staged = yield* stageExactCandidate(
      runtime,
      membership,
      body,
      anchorHash,
    );
    if (!staged) {
      rememberVote(runtime, vote);
      const state = engineRecoveryState(runtime);
      if (
        state !== undefined &&
        !state.pendingRequests.has(body.conversationId)
      ) {
        yield* requestCertifiedHistory(runtime, body.conversationId).pipe(
          Effect.mapError(persistenceFailure),
        );
      }
      return;
    }
    yield* persistVote(runtime, {
      body,
      anchorHash,
      message: vote.message,
      signerAgentId,
    });
    yield* ensureLocalVote(runtime, membership, body, anchorHash);
    yield* completeIfThreshold(runtime, membership, body, anchorHash);
  });

const proposeLocalHead = (
  runtime: EngineRuntime,
  conversationId: ConversationId,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const state = engineRecoveryState(runtime);
    const membership = state?.memberships.get(conversationId);
    const { position } = yield* durablePosition(runtime, conversationId);
    if (
      state === undefined ||
      membership === undefined ||
      position?.headRecordHash === undefined
    ) {
      return;
    }
    const body: ReanchorBodyValue = {
      moltzapVersion: membership.membership.moltzapVersion,
      kind: "reanchor_body",
      conversationId,
      membershipHash: membership.hash,
      previousAnchorHash: yield* Schema.decodeUnknown(AnchorHash)(
        position.currentAnchorHash,
      ).pipe(Effect.mapError(persistenceFailure)),
      selectedRecordHash: yield* Schema.decodeUnknown(RecordHash)(
        position.headRecordHash,
      ).pipe(Effect.mapError(persistenceFailure)),
      routerInstanceId: state.recovery.anchor.routerInstanceId,
    };
    const anchorHash = yield* hashAnchor(body).pipe(
      Effect.mapError(persistenceFailure),
    );
    if (!(yield* stageExactCandidate(runtime, membership, body, anchorHash))) {
      return;
    }
    yield* ensureLocalVote(runtime, membership, body, anchorHash);
    yield* completeIfThreshold(runtime, membership, body, anchorHash);
  }).pipe(Effect.mapError(persistenceFailure));

const replayPendingVotes = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  conversationId: ConversationId,
  headRecordHash: string,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const candidates = pendingVotes.get(runtime)?.get(conversationId);
    if (candidates === undefined) {
      return;
    }
    for (const votes of candidates.values()) {
      for (const vote of votes) {
        if (vote.statement.reanchor.selectedRecordHash === headRecordHash) {
          yield* processVerifiedVote(runtime, membership, vote);
        }
      }
    }
  });

const positionReady = (
  runtime: EngineRuntime,
  conversationId: ConversationId,
): Effect.Effect<void, RouterWorkerRecoveryError> =>
  Effect.gen(function* () {
    const state = engineRecoveryState(runtime);
    if (state === undefined) {
      return yield* recoveryFailure();
    }
    if (state.recovery.reason !== "router_restarted") {
      yield* markComplete(runtime, conversationId);
      return;
    }
    const membership = state.memberships.get(conversationId);
    const { position } = yield* durablePosition(runtime, conversationId);
    if (membership === undefined || position?.headRecordHash === undefined) {
      return;
    }
    yield* replayPendingVotes(
      runtime,
      membership,
      conversationId,
      position.headRecordHash,
    );
    if (!state.completedConversations.has(conversationId)) {
      yield* proposeLocalHead(runtime, conversationId);
    }
  }).pipe(Effect.mapError(recoveryFailure));

const recoverCompletedCurrentAnchor = (
  runtime: EngineRuntime,
  state: EngineRecoveryState,
  recovery: EndpointRecovery,
  conversationId: ConversationId,
): Effect.Effect<boolean, RouterWorkerRecoveryError> =>
  Effect.gen(function* () {
    if (state.recovery.reason !== "router_restarted") {
      return false;
    }
    const membership = state.memberships.get(conversationId);
    const position = recovery.positions.find(
      (item) => item.conversationId === conversationId,
    );
    const anchor = recovery.anchors.find(
      (item) =>
        item.conversationId === conversationId &&
        item.anchorHash === position?.currentAnchorHash &&
        item.previousAnchorHash !== undefined,
    );
    if (membership === undefined || anchor === undefined) {
      return false;
    }
    const completed = yield* decodeCanonical(
      CompletedReanchor,
      anchor.canonicalAnchor,
    ).pipe(Effect.mapError(recoveryFailure));
    yield* verifyCompletedReanchor({ completed, membership }).pipe(
      Effect.mapError(recoveryFailure),
    );
    if (
      completed.reanchor.routerInstanceId !==
      state.recovery.anchor.routerInstanceId
    ) {
      return false;
    }
    const conversation = runtime.conversations.get(conversationId);
    if (conversation !== undefined) {
      conversation.currentAnchor = completed;
    }
    yield* markComplete(runtime, conversationId);
    return true;
  });

const acceptVote = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessageValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const statement = yield* decodeCanonical(EvidenceStatement, message.body);
    if (statement.kind !== "reanchor_vote") {
      return ignored;
    }
    const membership = engineRecoveryState(runtime)?.memberships.get(
      statement.reanchor.conversationId,
    );
    if (membership === undefined) {
      return ignored;
    }
    yield* verifyOuterMessage({ message: ingress.message, membership });
    const representation = yield* Schema.encode(SignedMessage)(message);
    const verified = yield* verifyStableEvidence({
      representation,
      membership,
    });
    if (verified.statement.kind !== "reanchor_vote") {
      return ignored;
    }
    yield* processVerifiedVote(runtime, membership, {
      message: verified.message,
      statement: verified.statement,
    });
    return accepted;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
    Effect.mapError(persistenceFailure),
  );

const acceptCompleted = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  completed: CompletedReanchorValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const state = engineRecoveryState(runtime);
    const membership = state?.memberships.get(
      completed.reanchor.conversationId,
    );
    if (
      state === undefined ||
      membership === undefined ||
      state.recovery.reason !== "router_restarted" ||
      completed.reanchor.routerInstanceId !==
        state.recovery.anchor.routerInstanceId
    ) {
      return ignored;
    }
    yield* verifyOuterMessage({ message: ingress.message, membership });
    yield* verifyCompletedReanchor({ completed, membership });
    yield* runtime.input.store
      .applyCatchUpReanchor({
        conversationId: completed.reanchor.conversationId,
        anchorHash: completed.anchorHash,
        previousAnchorHash: completed.reanchor.previousAnchorHash,
        routerInstanceId: completed.reanchor.routerInstanceId,
        selectedRecordHash: completed.reanchor.selectedRecordHash,
        canonicalBody: yield* encodeCanonical(ReanchorBody, completed.reanchor),
        canonicalCompletedReanchor: yield* encodeCanonical(
          CompletedReanchor,
          completed,
        ),
      })
      .pipe(Effect.mapError(persistenceFailure));
    const conversation = runtime.conversations.get(
      completed.reanchor.conversationId,
    );
    if (conversation !== undefined) {
      conversation.currentAnchor = completed;
    }
    yield* markComplete(runtime, completed.reanchor.conversationId);
    return accepted;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
  );

/**
 * Accept verified re-anchor evidence or a completed direct packet.
 * @param runtime Endpoint runtime that owns recovery state.
 * @param ingress Authenticated Router ingress carrying the packet.
 * @param packet Re-anchor evidence or completed re-anchor packet.
 * @returns The packet disposition or a persistence failure.
 */
export const acceptReanchorPacket = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  packet: SignedMessageValue | CompletedReanchorValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  "kind" in packet
    ? acceptCompleted(runtime, ingress, packet)
    : acceptVote(runtime, ingress, packet);

/**
 * Closed recovery-only dispatcher used by RouterWorker's recovery pump.
 * @param runtime Endpoint runtime that owns recovery state.
 * @param ingress Authenticated Router ingress to dispatch.
 * @returns The ingress disposition or a persistence failure.
 */
export const acceptEngineRecoveryIngress = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> => {
  if (ingress.payload.kind === "evidence") {
    return acceptReanchorPacket(runtime, ingress, ingress.payload.message);
  }
  const packet = ingress.payload.packet;
  if (packet.kind === "completed_reanchor") {
    return acceptReanchorPacket(runtime, ingress, packet);
  }
  if (
    packet.kind === "catch_up_request" ||
    packet.kind === "catch_up_page" ||
    packet.kind === "catch_up_incomplete"
  ) {
    return acceptCatchUpPacket(runtime, ingress, packet);
  }
  return Effect.succeed(ignored);
};

const makeRecoveryCompletion = (): Effect.Effect<
  Deferred.Deferred<void, RouterWorkerRecoveryError>
> => Deferred.make();

const makeRecoveryState = (
  runtime: EngineRuntime,
  recovery: RouterWorkerRecovery,
  memberships: EngineRecoveryState["memberships"],
): Effect.Effect<EngineRecoveryState> =>
  Effect.gen(function* () {
    return {
      recovery,
      outbound: yield* Queue.unbounded<SignedMessageValue>(),
      completion: yield* makeRecoveryCompletion(),
      memberships,
      pendingRequests: new Map(),
      incompleteResponders: new Map(),
      completedConversations: new Set(),
      pendingOutbound: 0,
      onPositionReady: (conversationId) =>
        positionReady(runtime, conversationId),
    };
  });

const outboundCommitted = (state: EngineRecoveryState): Effect.Effect<void> =>
  Effect.sync(() => {
    state.pendingOutbound -= 1;
  }).pipe(Effect.zipRight(completeEngineRecoveryIfIdle(state)));

const sendRecoveryOutbound = (
  state: EngineRecoveryState,
  recovery: RouterWorkerRecovery,
): Effect.Effect<never, RouterWorkerSendError> =>
  Effect.forever(
    Queue.take(state.outbound).pipe(
      Effect.flatMap(recovery.send),
      Effect.tap(() => outboundCommitted(state)),
    ),
  );

const recoverConversation = (
  runtime: EngineRuntime,
  state: EngineRecoveryState,
  recovered: EndpointRecovery,
  conversationId: ConversationId,
) =>
  recoverCompletedCurrentAnchor(runtime, state, recovered, conversationId).pipe(
    Effect.flatMap((complete) =>
      complete ? Effect.void : requestCertifiedHistory(runtime, conversationId),
    ),
  );

const recoverPositions = (
  runtime: EngineRuntime,
  state: EngineRecoveryState,
  recovered: EndpointRecovery,
) =>
  Effect.forEach(
    state.memberships.keys(),
    (conversationId) =>
      recoverConversation(runtime, state, recovered, conversationId),
    { concurrency: 1, discard: true },
  );

const runRecovery = (
  runtime: EngineRuntime,
  state: EngineRecoveryState,
  recovered: EndpointRecovery,
  recovery: RouterWorkerRecovery,
) =>
  Effect.gen(function* () {
    const sender = yield* sendRecoveryOutbound(state, recovery).pipe(
      Effect.forkScoped,
    );
    yield* recoverPositions(runtime, state, recovered);
    yield* completeEngineRecoveryIfIdle(state);
    yield* Effect.raceFirst(
      Deferred.await(state.completion),
      Fiber.join(sender),
    );
  });

const clearRecoveryState = (
  runtime: EngineRuntime,
  state: EngineRecoveryState,
): Effect.Effect<void> =>
  Effect.sync(() => {
    removeEngineRecoveryState(runtime, state);
    pendingVotes.delete(runtime);
  });

/**
 * Reconcile every durable membership and await threshold-durable restart anchors.
 * @param runtime Endpoint runtime whose durable history is reconciled.
 * @param recoveryInput Router recovery generation and outbound sender.
 * @returns An effect that completes when every conversation is recovered.
 */
export const recoverCertifiedHistory = (
  runtime: EngineRuntime,
  recoveryInput: RouterWorkerRecovery,
): Effect.Effect<void, RouterWorkerRecoveryError | RouterWorkerSendError> =>
  Effect.gen(function* () {
    const recovered = yield* runtime.input.store
      .recover()
      .pipe(Effect.mapError(recoveryFailure));
    const memberships = yield* recoverMemberships(runtime, recovered);
    const state = yield* makeRecoveryState(runtime, recoveryInput, memberships);
    installEngineRecoveryState(runtime, state);
    pendingVotes.set(runtime, new Map());
    yield* Effect.scoped(
      runRecovery(runtime, state, recovered, recoveryInput),
    ).pipe(Effect.ensuring(clearRecoveryState(runtime, state)));
  }).pipe(Effect.withSpan("recoverCertifiedHistory"));
