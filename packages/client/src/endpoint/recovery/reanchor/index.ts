/** @file Threshold Router re-anchor orchestration for one active recovery run. */

import {
  MOLTZAP_VERSION,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Effect, Schema } from "effect";
import type { EngineRuntime } from "../../engine-types.js";
import type { EndpointRecovery } from "../../store.js";
import { protocolEvidence } from "../../engine-durability.js";
import {
  AnchorHash,
  type AnchorHash as AnchorHashValue,
  compareAgentIds,
  CompletedReanchor,
  type CompletedReanchor as CompletedReanchorValue,
  type ConversationId as ConversationIdValue,
  decodeCanonical,
  type DecodedOuterBody,
  encodeCanonical,
  EvidenceStatement,
  type EvidenceStatement as EvidenceStatementValue,
  hashAnchor,
  quorumThreshold,
  ReanchorBody,
  type ReanchorBody as ReanchorBodyValue,
  RecordHash,
  type RecordHash as RecordHashValue,
  signEvidenceMessage,
  type VerifiedMembership,
  verifyCompletedReanchor,
  verifyOuterMessage,
  verifyStableEvidence,
} from "../../representation.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
} from "../../router-worker/index.js";
import {
  type ActiveRecoveryState,
  currentRecoveryState,
  durablePosition,
  markConversationRecovered,
  observedAnchorIsResolved,
  observedHeadIsResolved,
  type PendingReanchorVote,
  queueRecoveryEvidence,
  queueRecoveryPacket,
  requestCertifiedHistory,
} from "../state.js";
import { restartEmptyPosition } from "./empty.js";

const acceptedDisposition: RouterIngressDisposition = "accepted";
const ignoredDisposition: RouterIngressDisposition = "ignored";

/**
 * Reconcile one conversation position and start or finish its re-anchor.
 * @param runtime Engine participating in active recovery.
 * @param conversationId Conversation whose catch-up responses are complete.
 * @returns Completion after re-anchor progress is durably queued.
 */
export function positionReady(
  runtime: EngineRuntime,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return positionReadyEffect(runtime, conversationId).pipe(
    Effect.withSpan("positionReady"),
  );
}

/**
 * Accept one stable re-anchor vote from a verified outer member envelope.
 * @param runtime Engine participating in active recovery.
 * @param ingress Authenticated Router delivery containing the outer envelope.
 * @param message Stable self-addressed vote evidence.
 * @returns Whether the vote was accepted or safely ignored.
 */
export function acceptReanchorVote(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessageValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return acceptReanchorVoteEffect(runtime, ingress, message).pipe(
    Effect.withSpan("acceptReanchorVote"),
  );
}

/**
 * Accept one completed threshold re-anchor from a fixed conversation member.
 * @param runtime Engine participating in active recovery.
 * @param ingress Authenticated Router delivery containing the completion.
 * @param completed Complete re-anchor and signer-attributed certificate.
 * @returns Whether the completion was accepted or safely ignored.
 */
export function acceptCompletedReanchor(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  completed: CompletedReanchorValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return acceptCompletedReanchorEffect(runtime, ingress, completed).pipe(
    Effect.withSpan("acceptCompletedReanchor"),
  );
}

function positionReadyEffect(
  runtime: EngineRuntime,
  conversationId: ConversationIdValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const state = currentRecoveryState(runtime);
  const membership = state?.memberships.get(conversationId);
  if (state === undefined || membership === undefined) {
    return Effect.fail(persistenceFailure());
  }
  return Effect.sync(() => {
    state.positionsReady.add(conversationId);
  }).pipe(
    Effect.zipRight(
      state.recovery.reason === "router_restarted"
        ? finishRestartedPosition(runtime, state, membership)
        : markConversationRecovered(runtime, conversationId),
    ),
  );
}

function finishRestartedPosition(
  runtime: EngineRuntime,
  state: ActiveRecoveryState,
  membership: VerifiedMembership,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const conversationId = membership.descriptor.conversationId;
  return durablePosition(runtime, conversationId).pipe(
    Effect.flatMap(({ recovery, position }) => {
      if (position === undefined) {
        return Effect.fail(persistenceFailure());
      }
      if (position.headRecordHash === undefined) {
        return restartEmptyPosition({
          runtime,
          state,
          membership,
          recovery,
          position,
        });
      }
      return Schema.decodeUnknown(RecordHash)(position.headRecordHash).pipe(
        Effect.mapError(persistenceFailure),
        Effect.flatMap((head) =>
          observedHeadsResolve(state, recovery, conversationId, head)
            ? advanceRestartedPosition({
                runtime,
                state,
                membership,
                recovery,
                position,
                head,
              })
            : Effect.fail(persistenceFailure()),
        ),
      );
    }),
  );
}

interface RestartedPositionInput {
  readonly runtime: EngineRuntime;
  readonly state: ActiveRecoveryState;
  readonly membership: VerifiedMembership;
  readonly recovery: EndpointRecovery;
  readonly position: EndpointRecovery["positions"][number];
  readonly head: RecordHashValue;
}

function advanceRestartedPosition(
  input: RestartedPositionInput,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const { head, membership, position, recovery, runtime, state } = input;
  const conversationId = membership.descriptor.conversationId;
  const completed = completedAnchorForRecovery(runtime, state, conversationId);
  if (completed !== undefined) {
    return queueRecoveryPacket(runtime, membership, completed).pipe(
      Effect.zipRight(markConversationRecovered(runtime, conversationId)),
    );
  }
  if (hasStagedSuccessor(recovery, conversationId, head)) {
    return Effect.void;
  }
  return replayReanchorVotes(runtime, membership, conversationId, head).pipe(
    Effect.zipRight(
      state.completedConversations.has(conversationId)
        ? Effect.void
        : proposeReanchor(runtime, membership, position),
    ),
  );
}

function observedHeadsResolve(
  state: ActiveRecoveryState,
  recovery: EndpointRecovery,
  conversationId: ConversationIdValue,
  head: RecordHashValue,
): boolean {
  const observed = state.observedHeads.get(conversationId);
  if (observed === undefined) {
    return true;
  }
  return [...observed].every((candidate) =>
    observedHeadIsResolved(recovery, conversationId, candidate, head),
  );
}

function completedAnchorForRecovery(
  runtime: EngineRuntime,
  state: ActiveRecoveryState,
  conversationId: ConversationIdValue,
): CompletedReanchorValue | undefined {
  const anchor = runtime.conversations.get(conversationId)?.currentAnchor;
  return anchor?.kind === "completed_reanchor" &&
    anchor.reanchor.routerInstanceId === state.recovery.anchor.routerInstanceId
    ? anchor
    : undefined;
}

function acceptReanchorVoteEffect(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessageValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return decodeCanonical(EvidenceStatement, message.body).pipe(
    Effect.flatMap((statement) => {
      if (statement.kind !== "reanchor_vote") {
        return Effect.succeed(ignoredDisposition);
      }
      const membership = currentRecoveryState(runtime)?.memberships.get(
        statement.reanchor.conversationId,
      );
      if (membership === undefined) {
        return Effect.succeed(ignoredDisposition);
      }
      return verifyInboundVote(runtime, ingress, message, membership);
    }),
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.succeed(ignoredDisposition),
    ),
    Effect.mapError(persistenceFailure),
  );
}

function verifyInboundVote(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessageValue,
  membership: VerifiedMembership,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return verifyOuterMessage({ message: ingress.message, membership }).pipe(
    Effect.zipRight(Schema.encode(SignedMessage)(message)),
    Effect.flatMap((representation) =>
      verifyStableEvidence({ representation, membership }),
    ),
    Effect.flatMap((verified) => {
      if (verified.statement.kind !== "reanchor_vote") {
        return Effect.succeed(ignoredDisposition);
      }
      return processReanchorVote(runtime, membership, {
        message: verified.message,
        statement: verified.statement,
      }).pipe(Effect.as(acceptedDisposition));
    }),
    Effect.mapError(persistenceFailure),
  );
}

function acceptCompletedReanchorEffect(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  completed: CompletedReanchorValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const state = currentRecoveryState(runtime);
  const membership = state?.memberships.get(completed.reanchor.conversationId);
  if (
    state === undefined ||
    membership === undefined ||
    !completionTargetsRecovery(state, completed)
  ) {
    return Effect.succeed(ignoredDisposition);
  }
  return verifyOuterMessage({ message: ingress.message, membership }).pipe(
    Effect.zipRight(verifyCompletedReanchor({ completed, membership })),
    Effect.zipRight(processCompletedVotes(runtime, membership, completed)),
    Effect.as(acceptedDisposition),
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.succeed(ignoredDisposition),
    ),
    Effect.mapError(persistenceFailure),
  );
}

function completionTargetsRecovery(
  state: ActiveRecoveryState,
  completed: CompletedReanchorValue,
): boolean {
  return (
    state.recovery.reason === "router_restarted" &&
    completed.reanchor.routerInstanceId ===
      state.recovery.anchor.routerInstanceId
  );
}

function processCompletedVotes(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  completed: CompletedReanchorValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.forEach(
    completed.certificate.votes,
    (representation) =>
      verifyStableEvidence({ representation, membership }).pipe(
        Effect.flatMap((verified) => {
          if (verified.statement.kind !== "reanchor_vote") {
            return Effect.fail(persistenceFailure());
          }
          return processReanchorVote(runtime, membership, {
            message: verified.message,
            statement: verified.statement,
          });
        }),
        Effect.mapError(persistenceFailure),
      ),
    { concurrency: 1, discard: true },
  );
}

function processReanchorVote(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  vote: PendingReanchorVote,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const state = currentRecoveryState(runtime);
  if (state === undefined || !voteTargetsRecovery(state, membership, vote)) {
    return Effect.void;
  }
  return hashAnchor(vote.statement.reanchor).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((expectedHash) => {
      if (expectedHash !== vote.statement.anchorHash) {
        return Effect.void;
      }
      return rememberReanchorVote(state, vote).pipe(
        Effect.zipRight(
          state.positionsReady.has(vote.statement.reanchor.conversationId)
            ? processReadyReanchorVote(runtime, state, membership, vote)
            : Effect.void,
        ),
      );
    }),
  );
}

function voteTargetsRecovery(
  state: ActiveRecoveryState,
  membership: VerifiedMembership,
  vote: PendingReanchorVote,
): boolean {
  if (state.recovery.reason !== "router_restarted") {
    return false;
  }
  const body = vote.statement.reanchor;
  return (
    body.membershipHash === membership.hash &&
    body.routerInstanceId === state.recovery.anchor.routerInstanceId
  );
}

function processReadyReanchorVote(
  runtime: EngineRuntime,
  state: ActiveRecoveryState,
  membership: VerifiedMembership,
  vote: PendingReanchorVote,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const body = vote.statement.reanchor;
  return durablePosition(runtime, body.conversationId).pipe(
    Effect.flatMap(({ recovery, position }) => {
      if (position?.headRecordHash === undefined) {
        return Effect.fail(persistenceFailure());
      }
      return decodePosition(
        position.headRecordHash,
        position.currentAnchorHash,
      ).pipe(
        Effect.flatMap(({ head, anchor }) =>
          reconcileCandidatePosition({
            runtime,
            state,
            recovery,
            body,
            head,
            anchor,
          }),
        ),
        Effect.flatMap((ready) =>
          ready ? certifyReanchorVote(runtime, membership, vote) : Effect.void,
        ),
      );
    }),
  );
}

function decodePosition(
  headRecordHash: string,
  currentAnchorHash: string,
): Effect.Effect<
  Readonly<{ head: RecordHashValue; anchor: AnchorHashValue }>,
  RouterWorkerPersistenceError
> {
  return Effect.all({
    head: Schema.decodeUnknown(RecordHash)(headRecordHash),
    anchor: Schema.decodeUnknown(AnchorHash)(currentAnchorHash),
  }).pipe(Effect.mapError(persistenceFailure));
}

interface CandidatePositionInput {
  readonly runtime: EngineRuntime;
  readonly state: ActiveRecoveryState;
  readonly recovery: EndpointRecovery;
  readonly body: ReanchorBodyValue;
  readonly head: RecordHashValue;
  readonly anchor: AnchorHashValue;
}

function reconcileCandidatePosition(
  input: CandidatePositionInput,
): Effect.Effect<boolean, RouterWorkerPersistenceError> {
  return selectedHeadReady(input).pipe(
    Effect.flatMap((headReady) => {
      if (!headReady) {
        return Effect.succeed(false);
      }
      return previousAnchorReady(input.recovery, input.body, input.anchor);
    }),
  );
}

function selectedHeadReady(
  input: CandidatePositionInput,
): Effect.Effect<boolean, RouterWorkerPersistenceError> {
  const { body, head, recovery, runtime, state } = input;
  if (body.selectedRecordHash === head) {
    return Effect.succeed(
      !hasStagedSuccessor(recovery, body.conversationId, head),
    );
  }
  if (
    observedHeadIsResolved(
      recovery,
      body.conversationId,
      body.selectedRecordHash,
      head,
    )
  ) {
    return Effect.succeed(false);
  }
  if (hasStagedReanchor(recovery, body)) {
    return Effect.fail(persistenceFailure());
  }
  return Effect.sync(() => {
    state.positionsReady.delete(body.conversationId);
  }).pipe(
    Effect.zipRight(requestCertifiedHistory(runtime, body.conversationId)),
    Effect.as(false),
  );
}

function previousAnchorReady(
  recovery: EndpointRecovery,
  body: ReanchorBodyValue,
  anchor: AnchorHashValue,
): Effect.Effect<boolean, RouterWorkerPersistenceError> {
  if (body.previousAnchorHash === anchor) {
    return Effect.succeed(true);
  }
  return observedAnchorIsResolved(
    recovery,
    body.conversationId,
    body.previousAnchorHash,
    anchor,
  )
    ? Effect.succeed(false)
    : Effect.fail(persistenceFailure());
}

function hasStagedReanchor(
  recovery: EndpointRecovery,
  body: ReanchorBodyValue,
): boolean {
  return recovery.stagedReanchors.some(
    (candidate) =>
      candidate.conversationId === body.conversationId &&
      candidate.routerInstanceId === body.routerInstanceId,
  );
}

function proposeReanchor(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  position: EndpointRecovery["positions"][number],
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const state = currentRecoveryState(runtime);
  if (
    state === undefined ||
    state.recovery.reason !== "router_restarted" ||
    position.headRecordHash === undefined
  ) {
    return Effect.fail(persistenceFailure());
  }
  return makeReanchorBody(
    state,
    membership,
    position,
    position.headRecordHash,
  ).pipe(
    Effect.flatMap((body) =>
      hashAnchor(body).pipe(
        Effect.mapError(persistenceFailure),
        Effect.flatMap((anchorHash) =>
          proposeReanchorCandidate(runtime, membership, body, anchorHash),
        ),
      ),
    ),
  );
}

function makeReanchorBody(
  state: ActiveRecoveryState,
  membership: VerifiedMembership,
  position: EndpointRecovery["positions"][number],
  selectedRecordHash: string,
): Effect.Effect<ReanchorBodyValue, RouterWorkerPersistenceError> {
  return Schema.decodeUnknown(ReanchorBody)({
    moltzapVersion: MOLTZAP_VERSION,
    kind: "reanchor_body",
    conversationId: membership.descriptor.conversationId,
    membershipHash: membership.hash,
    previousAnchorHash: position.currentAnchorHash,
    selectedRecordHash,
    routerInstanceId: state.recovery.anchor.routerInstanceId,
  }).pipe(Effect.mapError(persistenceFailure));
}

function proposeReanchorCandidate(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return stageReanchorCandidate(runtime, membership, body, anchorHash).pipe(
    Effect.flatMap((staged) =>
      staged ? Effect.void : Effect.fail(persistenceFailure()),
    ),
    Effect.zipRight(
      ensureLocalReanchorVote(runtime, membership, body, anchorHash),
    ),
    Effect.zipRight(
      completeReanchorAtThreshold(runtime, membership, body, anchorHash),
    ),
  );
}

function certifyReanchorVote(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  vote: PendingReanchorVote,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const body = vote.statement.reanchor;
  const anchorHash = vote.statement.anchorHash;
  return stageReanchorCandidate(runtime, membership, body, anchorHash).pipe(
    Effect.flatMap((staged) =>
      staged ? Effect.void : Effect.fail(persistenceFailure()),
    ),
    Effect.zipRight(persistReanchorVote(runtime, vote)),
    Effect.zipRight(
      ensureLocalReanchorVote(runtime, membership, body, anchorHash),
    ),
    Effect.zipRight(
      completeReanchorAtThreshold(runtime, membership, body, anchorHash),
    ),
  );
}

function rememberReanchorVote(
  state: ActiveRecoveryState,
  vote: PendingReanchorVote,
): Effect.Effect<void> {
  return Effect.sync(() => {
    const conversationId = vote.statement.reanchor.conversationId;
    const candidates =
      state.pendingVotes.get(conversationId) ??
      new Map<
        AnchorHashValue,
        Map<
          PendingReanchorVote["statement"]["signerAgentId"],
          PendingReanchorVote
        >
      >();
    state.pendingVotes.set(conversationId, candidates);
    const votes =
      candidates.get(vote.statement.anchorHash) ??
      new Map<
        PendingReanchorVote["statement"]["signerAgentId"],
        PendingReanchorVote
      >();
    candidates.set(vote.statement.anchorHash, votes);
    votes.set(vote.statement.signerAgentId, vote);
    const heads =
      state.observedHeads.get(conversationId) ?? new Set<RecordHashValue>();
    state.observedHeads.set(conversationId, heads);
    heads.add(vote.statement.reanchor.selectedRecordHash);
  });
}

function stageReanchorCandidate(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<boolean, RouterWorkerPersistenceError> {
  return durablePosition(runtime, body.conversationId).pipe(
    Effect.flatMap(({ recovery, position }) => {
      const state = currentRecoveryState(runtime);
      if (
        state === undefined ||
        position === undefined ||
        position.headRecordHash === undefined ||
        !candidateMatchesPosition(state, membership, position, body)
      ) {
        return Effect.succeed(false);
      }
      if (
        hasStagedSuccessor(
          recovery,
          body.conversationId,
          body.selectedRecordHash,
        )
      ) {
        return Effect.succeed(false);
      }
      const staged = stagedCandidate(recovery, body);
      if (staged !== undefined && staged.anchorHash !== anchorHash) {
        return Effect.fail(persistenceFailure());
      }
      return persistReanchorCandidate(runtime, body, anchorHash);
    }),
    Effect.mapError(persistenceFailure),
  );
}

function candidateMatchesPosition(
  state: ActiveRecoveryState,
  membership: VerifiedMembership,
  position: EndpointRecovery["positions"][number],
  body: ReanchorBodyValue,
): boolean {
  if (
    state.recovery.reason !== "router_restarted" ||
    position.headRecordHash === undefined
  ) {
    return false;
  }
  return [
    state.positionsReady.has(body.conversationId),
    body.membershipHash === membership.hash,
    body.previousAnchorHash === position.currentAnchorHash,
    body.selectedRecordHash === position.headRecordHash,
    body.routerInstanceId === state.recovery.anchor.routerInstanceId,
  ].every((matches) => matches);
}

function stagedCandidate(
  recovery: EndpointRecovery,
  body: ReanchorBodyValue,
): EndpointRecovery["stagedReanchors"][number] | undefined {
  return recovery.stagedReanchors.find(
    (candidate) =>
      candidate.conversationId === body.conversationId &&
      candidate.previousAnchorHash === body.previousAnchorHash &&
      candidate.routerInstanceId === body.routerInstanceId,
  );
}

function hasStagedSuccessor(
  recovery: EndpointRecovery,
  conversationId: ConversationIdValue,
  head: RecordHashValue,
): boolean {
  return recovery.stagedRecords.some(
    (record) =>
      record.conversationId === conversationId &&
      record.previousRecordHash === head &&
      !recovery.certifiedRecords.some(
        (certified) =>
          certified.conversationId === conversationId &&
          certified.recordHash === record.recordHash,
      ),
  );
}

function persistReanchorCandidate(
  runtime: EngineRuntime,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<boolean, RouterWorkerPersistenceError> {
  return encodeCanonical(ReanchorBody, body).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((canonicalBody) =>
      runtime.input.store.stageReanchor({
        conversationId: body.conversationId,
        anchorHash,
        previousAnchorHash: body.previousAnchorHash,
        routerInstanceId: body.routerInstanceId,
        selectedRecordHash: body.selectedRecordHash,
        canonicalBody,
      }),
    ),
    Effect.mapError(persistenceFailure),
    Effect.as(true),
  );
}

function persistReanchorVote(
  runtime: EngineRuntime,
  vote: PendingReanchorVote,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return protocolEvidence(
    vote.statement.reanchor.conversationId,
    "reanchor",
    vote.statement.anchorHash,
    vote.message,
  ).pipe(
    Effect.flatMap((evidence) => runtime.input.store.mergeEvidence(evidence)),
    Effect.mapError(persistenceFailure),
    Effect.asVoid,
  );
}

function ensureLocalReanchorVote(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const state = currentRecoveryState(runtime);
  if (state === undefined) {
    return Effect.fail(persistenceFailure());
  }
  const statement = localReanchorVoteStatement(runtime, body, anchorHash);
  return decodeReanchorVotes(runtime, membership, body, anchorHash).pipe(
    Effect.flatMap((votes) => {
      const message = votes.find(
        (vote) => vote.senderAgentId === runtime.input.localAgentCard.agentId,
      );
      if (message === undefined) {
        return createLocalReanchorVote(runtime, state, membership, statement);
      }
      const vote: PendingReanchorVote = { message, statement };
      return reanchorVoteIsRemembered(state, vote)
        ? Effect.void
        : queueRecoveryEvidence(runtime, membership, message).pipe(
            Effect.zipRight(rememberReanchorVote(state, vote)),
          );
    }),
  );
}

function localReanchorVoteStatement(
  runtime: EngineRuntime,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): PendingReanchorVote["statement"] {
  return {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "reanchor_vote",
    signerAgentId: runtime.input.localAgentCard.agentId,
    anchorHash,
    reanchor: body,
  };
}

function reanchorVoteIsRemembered(
  state: ActiveRecoveryState,
  vote: PendingReanchorVote,
): boolean {
  return (
    state.pendingVotes
      .get(vote.statement.reanchor.conversationId)
      ?.get(vote.statement.anchorHash)
      ?.has(vote.statement.signerAgentId) === true
  );
}

function createLocalReanchorVote(
  runtime: EngineRuntime,
  state: ActiveRecoveryState,
  membership: VerifiedMembership,
  statement: PendingReanchorVote["statement"],
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return signEvidenceMessage({
    statement,
    agentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
  }).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((message) => {
      const vote: PendingReanchorVote = { message, statement };
      return persistReanchorVote(runtime, vote).pipe(
        Effect.zipRight(queueRecoveryEvidence(runtime, membership, message)),
        Effect.zipRight(rememberReanchorVote(state, vote)),
      );
    }),
  );
}

function completeReanchorAtThreshold(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const state = currentRecoveryState(runtime);
  if (state?.completedConversations.has(body.conversationId) === true) {
    return Effect.void;
  }
  return decodeReanchorVotes(runtime, membership, body, anchorHash).pipe(
    Effect.map((votes) =>
      [...votes].sort((left, right) =>
        compareAgentIds(left.senderAgentId, right.senderAgentId),
      ),
    ),
    Effect.flatMap((votes) =>
      votes.length < quorumThreshold(membership.members.length)
        ? Effect.succeed(undefined)
        : assembleCompletedReanchor(body, anchorHash, votes),
    ),
    Effect.flatMap((completed) =>
      completed === undefined
        ? Effect.void
        : finalizeCompletedReanchor(runtime, membership, completed),
    ),
  );
}

function assembleCompletedReanchor(
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
  votes: readonly SignedMessageValue[],
): Effect.Effect<CompletedReanchorValue, RouterWorkerPersistenceError> {
  return Effect.forEach(votes, (vote) => Schema.encode(SignedMessage)(vote), {
    concurrency: 1,
  }).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((encoded) => {
      const first = encoded[0];
      if (first === undefined) {
        return Effect.fail(persistenceFailure());
      }
      const completed: CompletedReanchorValue = {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "completed_reanchor",
        anchorHash,
        reanchor: body,
        certificate: {
          moltzapVersion: MOLTZAP_VERSION,
          kind: "reanchor_certificate",
          anchorHash,
          votes: [first, ...encoded.slice(1)],
        },
      };
      return Effect.succeed(completed);
    }),
  );
}

function finalizeCompletedReanchor(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  completed: CompletedReanchorValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return verifyCompletedReanchor({ completed, membership }).pipe(
    Effect.mapError(persistenceFailure),
    Effect.zipRight(persistCompletedReanchor(runtime, completed)),
    Effect.zipRight(queueRecoveryPacket(runtime, membership, completed)),
    Effect.zipRight(
      markConversationRecovered(runtime, completed.reanchor.conversationId),
    ),
  );
}

function persistCompletedReanchor(
  runtime: EngineRuntime,
  completed: CompletedReanchorValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const body = completed.reanchor;
  return Effect.all({
    canonicalBody: encodeCanonical(ReanchorBody, body),
    canonicalCompletedReanchor: encodeCanonical(CompletedReanchor, completed),
  }).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((canonical) =>
      runtime.input.store.completeReanchor({
        conversationId: body.conversationId,
        anchorHash: completed.anchorHash,
        previousAnchorHash: body.previousAnchorHash,
        routerInstanceId: body.routerInstanceId,
        selectedRecordHash: body.selectedRecordHash,
        ...canonical,
      }),
    ),
    Effect.flatMap(() =>
      Effect.sync(() => {
        const conversation = runtime.conversations.get(body.conversationId);
        if (conversation !== undefined) {
          conversation.currentAnchor = completed;
        }
      }),
    ),
    Effect.mapError(persistenceFailure),
  );
}

function decodeReanchorVotes(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<readonly SignedMessageValue[], RouterWorkerPersistenceError> {
  return runtime.input.store.recover().pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((recovery) =>
      Effect.forEach(
        recovery.evidence.filter((evidence) =>
          evidenceTargetsAnchor(evidence, body.conversationId, anchorHash),
        ),
        (evidence) =>
          verifyStoredReanchorVote(evidence, membership, body, anchorHash),
        { concurrency: 1 },
      ),
    ),
    Effect.flatMap((votes) =>
      votesHaveUniqueSigners(votes)
        ? Effect.succeed(votes)
        : Effect.fail(persistenceFailure()),
    ),
  );
}

function evidenceTargetsAnchor(
  evidence: EndpointRecovery["evidence"][number],
  conversationId: ConversationIdValue,
  anchorHash: AnchorHashValue,
): boolean {
  return (
    evidence.kind === "reanchor" &&
    evidence.conversationId === conversationId &&
    evidence.subjectId === anchorHash
  );
}

function verifyStoredReanchorVote(
  evidence: EndpointRecovery["evidence"][number],
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<SignedMessageValue, RouterWorkerPersistenceError> {
  return decodeCanonical(SignedMessage, evidence.canonicalEvidence).pipe(
    Effect.flatMap((message) => Schema.encode(SignedMessage)(message)),
    Effect.flatMap((representation) =>
      verifyStableEvidence({ representation, membership }),
    ),
    Effect.flatMap((verified) =>
      storedVoteMatches(verified.statement, body, anchorHash)
        ? Effect.succeed(verified.message)
        : Effect.fail(persistenceFailure()),
    ),
    Effect.mapError(persistenceFailure),
  );
}

function storedVoteMatches(
  statement: EvidenceStatementValue,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): boolean {
  return (
    statement.kind === "reanchor_vote" &&
    statement.anchorHash === anchorHash &&
    sameReanchorBody(statement.reanchor, body)
  );
}

function votesHaveUniqueSigners(votes: readonly SignedMessageValue[]): boolean {
  return (
    new Set<PendingReanchorVote["statement"]["signerAgentId"]>(
      votes.map((vote) => vote.senderAgentId),
    ).size === votes.length
  );
}

function sameReanchorBody(
  left: ReanchorBodyValue,
  right: ReanchorBodyValue,
): boolean {
  return [
    left.conversationId === right.conversationId,
    left.membershipHash === right.membershipHash,
    left.previousAnchorHash === right.previousAnchorHash,
    left.selectedRecordHash === right.selectedRecordHash,
    left.routerInstanceId === right.routerInstanceId,
  ].every((matches) => matches);
}

function replayReanchorVotes(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  conversationId: ConversationIdValue,
  headRecordHash: RecordHashValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const candidates =
    currentRecoveryState(runtime)?.pendingVotes.get(conversationId);
  if (candidates === undefined) {
    return Effect.void;
  }
  return Effect.forEach(
    candidates.values(),
    (votes) => replayCandidateVotes(runtime, membership, votes, headRecordHash),
    { concurrency: 1, discard: true },
  );
}

function replayCandidateVotes(
  runtime: EngineRuntime,
  membership: VerifiedMembership,
  votes: ReadonlyMap<
    PendingReanchorVote["statement"]["signerAgentId"],
    PendingReanchorVote
  >,
  headRecordHash: RecordHashValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.forEach(
    votes.values(),
    (vote) =>
      vote.statement.reanchor.selectedRecordHash === headRecordHash
        ? processReanchorVote(runtime, membership, vote)
        : Effect.void,
    { concurrency: 1, discard: true },
  );
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}
