/** @file Router-restart head reconciliation and threshold re-anchoring. */

import {
  type AgentId,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Deferred, Effect, Fiber, Queue, Schema } from "effect";
import type { ConversationId } from "../contract.js";
import {
  acceptCatchUpPacket,
  completeEngineRecoveryIfIdle,
  engineRecoveryState,
  installEngineRecoveryState,
  recoverMemberships,
  removeEngineRecoveryState,
  requestCertifiedHistory,
  type EngineRecoveryState,
} from "./engine-catch-up.js";
import type { EngineRuntime } from "./engine-types.js";
import {
  compareAgentIds,
  CompletedReanchor,
  type CompletedReanchor as CompletedReanchorValue,
  decodeCanonical,
  durabilityThreshold,
  encodeCanonical,
  EvidenceStatement,
  type EvidenceStatement as EvidenceStatementValue,
  hashAnchor,
  ReanchorBody,
  type ReanchorBody as ReanchorBodyValue,
  signEvidenceMessage,
  signOuterEvidence,
  signOuterPacket,
  AnchorHash,
  RecordHash,
  type VerifiedMembership,
  verifyCompletedReanchor,
  verifyOuterMessage,
  verifyStableEvidence,
} from "./representation.js";
import type { DecodedOuterBody } from "./representation.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
  RouterWorkerRecoveryError,
  type RouterWorkerRecovery,
  type RouterWorkerSendError,
} from "./router-worker.js";
import type { EndpointRecovery } from "./store.js";

const accepted = "accepted" as const;
const ignored = "ignored" as const;
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

const pendingVotes = new WeakMap<
  EngineRuntime,
  Map<ConversationId, Map<string, PendingVote[]>>
>();

const recoveryQueue = (
  runtime: EngineRuntime,
  message: SignedMessageValue,
): Effect.Effect<void, RouterWorkerPersistenceError> => {
  const state = engineRecoveryState(runtime);
  if (state === undefined) return Effect.fail(persistenceFailure());
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
  if (state === undefined) return Effect.void;
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

const sameBody = (left: ReanchorBodyValue, right: ReanchorBodyValue) =>
  left.conversationId === right.conversationId &&
  left.membershipHash === right.membershipHash &&
  left.previousAnchorHash === right.previousAnchorHash &&
  left.selectedRecordHash === right.selectedRecordHash &&
  left.routerInstanceId === right.routerInstanceId;

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
    if (
      state === undefined ||
      state.recovery.reason !== "router_restarted" ||
      position?.headRecordHash === undefined ||
      body.membershipHash !== membership.hash ||
      body.previousAnchorHash !== position.currentAnchorHash ||
      body.selectedRecordHash !== position.headRecordHash ||
      body.routerInstanceId !== state.recovery.anchor.routerInstanceId
    )
      return false;
    const existing = recovery.stagedReanchors.find(
      (item) =>
        item.conversationId === body.conversationId &&
        item.previousAnchorHash === body.previousAnchorHash &&
        item.routerInstanceId === body.routerInstanceId,
    );
    if (existing !== undefined && existing.anchorHash !== anchorHash)
      return false;
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

const persistVote = (
  runtime: EngineRuntime,
  body: ReanchorBodyValue,
  anchorHash: string,
  message: SignedMessageValue,
  signerAgentId: AgentId,
) =>
  encodeCanonical(SignedMessage, message).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((canonicalEvidence) =>
      runtime.input.store.mergeEvidence({
        conversationId: body.conversationId,
        kind: "reanchor",
        subjectId: anchorHash,
        evidenceKey: signerAgentId,
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
            )
              return yield* persistenceFailure();
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
    if (retained !== undefined) return;
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
    yield* persistVote(
      runtime,
      body,
      anchorHash,
      local,
      runtime.input.localAgentCard.agentId,
    );
    yield* queueEvidence(runtime, membership, local);
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
    if (votes.length < durabilityThreshold(membership.members.length)) return;
    const encoded = yield* Effect.forEach(
      votes,
      (message) => Schema.encode(SignedMessage)(message),
      { concurrency: 1 },
    ).pipe(Effect.mapError(persistenceFailure));
    const first = encoded[0];
    if (first === undefined) return yield* persistenceFailure();
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
    yield* runtime.input.store
      .completeReanchor({
        conversationId: body.conversationId,
        anchorHash,
        previousAnchorHash: body.previousAnchorHash,
        routerInstanceId: body.routerInstanceId,
        selectedRecordHash: body.selectedRecordHash,
        canonicalBody: yield* encodeCanonical(ReanchorBody, body),
        canonicalCompletedReanchor: yield* encodeCanonical(
          CompletedReanchor,
          completed,
        ),
      })
      .pipe(Effect.mapError(persistenceFailure));
    const conversation = runtime.conversations.get(body.conversationId);
    if (conversation !== undefined) conversation.currentAnchor = completed;
    yield* queueCompleted(runtime, membership, completed);
    yield* markComplete(runtime, body.conversationId);
  }).pipe(Effect.mapError(persistenceFailure));

const rememberVote = (runtime: EngineRuntime, vote: PendingVote): void => {
  const conversations = pendingVotes.get(runtime) ?? new Map();
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
  )
    retained.push(vote);
  candidates.set(vote.statement.anchorHash, retained);
};

const processVerifiedVote = (
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  vote: PendingVote,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const expectedHash = yield* hashAnchor(vote.statement.reanchor).pipe(
      Effect.mapError(persistenceFailure),
    );
    if (expectedHash !== vote.statement.anchorHash) return;
    const staged = yield* stageExactCandidate(
      runtime,
      membership,
      vote.statement.reanchor,
      vote.statement.anchorHash,
    );
    if (!staged) {
      rememberVote(runtime, vote);
      const state = engineRecoveryState(runtime);
      if (
        state !== undefined &&
        !state.pendingRequests.has(vote.statement.reanchor.conversationId)
      ) {
        yield* requestCertifiedHistory(
          runtime,
          vote.statement.reanchor.conversationId,
        ).pipe(Effect.mapError(persistenceFailure));
      }
      return;
    }
    yield* persistVote(
      runtime,
      vote.statement.reanchor,
      vote.statement.anchorHash,
      vote.message,
      vote.statement.signerAgentId,
    );
    yield* ensureLocalVote(
      runtime,
      membership,
      vote.statement.reanchor,
      vote.statement.anchorHash,
    );
    yield* completeIfThreshold(
      runtime,
      membership,
      vote.statement.reanchor,
      vote.statement.anchorHash,
    );
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
    )
      return;
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
    if (!(yield* stageExactCandidate(runtime, membership, body, anchorHash)))
      return;
    yield* ensureLocalVote(runtime, membership, body, anchorHash);
    yield* completeIfThreshold(runtime, membership, body, anchorHash);
  }).pipe(Effect.mapError(persistenceFailure));

const positionReady = (
  runtime: EngineRuntime,
  conversationId: ConversationId,
): Effect.Effect<void, RouterWorkerRecoveryError> =>
  Effect.gen(function* () {
    const state = engineRecoveryState(runtime);
    if (state === undefined) return yield* recoveryFailure();
    if (state.recovery.reason !== "router_restarted") {
      yield* markComplete(runtime, conversationId);
      return;
    }
    const membership = state.memberships.get(conversationId);
    const { position } = yield* durablePosition(runtime, conversationId);
    if (membership === undefined || position?.headRecordHash === undefined)
      return;
    const candidates = pendingVotes.get(runtime)?.get(conversationId);
    if (candidates !== undefined) {
      for (const votes of candidates.values()) {
        for (const vote of votes) {
          if (
            vote.statement.reanchor.selectedRecordHash ===
            position.headRecordHash
          ) {
            yield* processVerifiedVote(runtime, membership, vote);
          }
        }
      }
    }
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
    if (state.recovery.reason !== "router_restarted") return false;
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
    if (membership === undefined || anchor === undefined) return false;
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
    )
      return false;
    const conversation = runtime.conversations.get(conversationId);
    if (conversation !== undefined) conversation.currentAnchor = completed;
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
    if (statement.kind !== "reanchor_vote") return ignored;
    const membership = engineRecoveryState(runtime)?.memberships.get(
      statement.reanchor.conversationId,
    );
    if (membership === undefined) return ignored;
    yield* verifyOuterMessage({ message: ingress.message, membership });
    const representation = yield* Schema.encode(SignedMessage)(message);
    const verified = yield* verifyStableEvidence({
      representation,
      membership,
    });
    if (verified.statement.kind !== "reanchor_vote") return ignored;
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
    )
      return ignored;
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
    if (conversation !== undefined) conversation.currentAnchor = completed;
    yield* markComplete(runtime, completed.reanchor.conversationId);
    return accepted;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
  );

/** Accept verified re-anchor evidence or a completed direct packet. */
export const acceptReanchorPacket = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  packet: SignedMessageValue | CompletedReanchorValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  "kind" in packet
    ? acceptCompleted(runtime, ingress, packet)
    : acceptVote(runtime, ingress, packet);

/** Closed recovery-only dispatcher used by RouterWorker's recovery pump. */
export const acceptEngineRecoveryIngress = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> => {
  if (ingress.payload.kind === "evidence") {
    return acceptReanchorPacket(runtime, ingress, ingress.payload.message);
  }
  switch (ingress.payload.packet.kind) {
    case "catch_up_request":
    case "catch_up_page":
    case "catch_up_incomplete":
      return acceptCatchUpPacket(runtime, ingress, ingress.payload.packet);
    case "completed_reanchor":
      return acceptReanchorPacket(runtime, ingress, ingress.payload.packet);
    default:
      return Effect.succeed(ignored);
  }
};

/** Reconcile every durable membership and await threshold-durable restart anchors. */
export const recoverCertifiedHistory = (
  runtime: EngineRuntime,
  recoveryInput: RouterWorkerRecovery,
): Effect.Effect<void, RouterWorkerRecoveryError | RouterWorkerSendError> =>
  Effect.gen(function* () {
    const recovered = yield* runtime.input.store
      .recover()
      .pipe(Effect.mapError(recoveryFailure));
    const memberships = yield* recoverMemberships(runtime, recovered);
    const state: EngineRecoveryState = {
      recovery: recoveryInput,
      outbound: yield* Queue.unbounded<SignedMessageValue>(),
      completion: yield* Deferred.make<void, RouterWorkerRecoveryError>(),
      memberships,
      pendingRequests: new Map(),
      incompleteResponders: new Map(),
      completedConversations: new Set(),
      pendingOutbound: 0,
      onPositionReady: (conversationId) =>
        positionReady(runtime, conversationId),
    };
    installEngineRecoveryState(runtime, state);
    pendingVotes.set(runtime, new Map());
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sender = yield* Effect.forever(
          Queue.take(state.outbound).pipe(
            Effect.flatMap(recoveryInput.send),
            Effect.tap(() =>
              Effect.sync(() => {
                state.pendingOutbound -= 1;
              }).pipe(Effect.zipRight(completeEngineRecoveryIfIdle(state))),
            ),
          ),
        ).pipe(Effect.forkScoped);
        yield* Effect.forEach(
          memberships.keys(),
          (conversationId) =>
            recoverCompletedCurrentAnchor(
              runtime,
              state,
              recovered,
              conversationId,
            ).pipe(
              Effect.flatMap((complete) =>
                complete
                  ? Effect.void
                  : requestCertifiedHistory(runtime, conversationId),
              ),
            ),
          { concurrency: 1, discard: true },
        );
        yield* completeEngineRecoveryIfIdle(state);
        yield* Effect.raceFirst(
          Deferred.await(state.completion),
          Fiber.join(sender),
        );
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          removeEngineRecoveryState(runtime, state);
          pendingVotes.delete(runtime);
        }),
      ),
    );
  });
