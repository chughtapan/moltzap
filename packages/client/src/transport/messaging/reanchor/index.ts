/**
 * @file Threshold Router re-anchor for one recovery run: when a position is
 * ready, propose or relay the run's anchor, take members' votes, and certify
 * the re-anchor once a quorum votes for it.
 */

import {
  MOLTZAP_VERSION,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Effect, Schema } from "effect";
import type { EndpointRecovery } from "../../../store/index.js";
import type { EngineRuntime } from "../runtime/index.js";
import {
  type RouterDiscontinuityReason,
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
  type RouterWorkerRecovery,
} from "../../router/index.js";
import {
  AnchorHash,
  type AnchorHash as AnchorHashValue,
  type CompletedReanchor as CompletedReanchorValue,
  type ConversationId as ConversationIdValue,
  decodeCanonical,
  type DecodedOuterBody,
  encodeCanonical,
  EvidenceStatement,
  hashAnchor,
  quorumThreshold,
  ReanchorBody,
  type ReanchorBody as ReanchorBodyValue,
  RecordHash,
  type RecordHash as RecordHashValue,
  type RouterAnchor,
  signEvidenceMessage,
  type VerifiedMembership,
  verifyCompletedReanchor,
  verifyOuterMessage,
  verifyStableEvidence,
} from "../../wire/index.js";
import {
  anchorRouterInstanceId,
  durablePosition,
  observedAnchorIsResolved,
  observedHeadIsResolved,
} from "../history/index.js";
import { restartEmptyPosition } from "./empty.js";
import {
  assembleCompletedReanchor,
  decodeReanchorVotes,
  makeReanchorVotes,
  type PendingReanchorVote,
  persistCompletedReanchor,
  persistReanchorVote,
  reanchorVoteIsRemembered,
  type ReanchorVotes,
  rememberReanchorVote,
} from "./votes.js";

const acceptedDisposition: RouterIngressDisposition = "accepted";
const ignoredDisposition: RouterIngressDisposition = "ignored";

/**
 * What a re-anchor needs from the recovery run it belongs to. The run builds
 * it, so re-anchor never reads the run's state directly.
 */
export interface ReanchorRunPort {
  readonly runtime: EngineRuntime;
  readonly reason: RouterDiscontinuityReason;
  /** The Router instance the run polls, which a re-anchor moves conversations to. */
  readonly routerInstanceId: RouterWorkerRecovery["anchor"]["routerInstanceId"];
  /** Conversations anchored to another Router instance; only these re-anchor. */
  readonly reanchoring: ReadonlySet<string>;
  /** Whether the run is still the engine's active recovery. */
  readonly isActive: () => boolean;
  /** The active run's verified membership of a conversation. */
  readonly membership: (
    conversationId: ConversationIdValue,
  ) => VerifiedMembership | undefined;
  readonly isRecovered: (conversationId: ConversationIdValue) => boolean;
  readonly markRecovered: (
    conversationId: ConversationIdValue,
  ) => Effect.Effect<void>;
  /** Sign `body` and route it as the run routes its traffic. */
  readonly queue: (
    membership: VerifiedMembership,
    body: DecodedOuterBody,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
  /** Ask members again for the history after the conversation's position. */
  readonly requestCatchUp: (
    conversationId: ConversationIdValue,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
}

/** One recovery run's re-anchor: the run's port and its vote memory. */
export interface ReanchorRun extends ReanchorRunPort {
  readonly votes: ReanchorVotes;
}

/**
 * Start one recovery run's re-anchor with empty vote memory.
 * @param port What the run exposes to its re-anchor.
 * @returns The run's re-anchor, which the run passes to every operation.
 */
export function startReanchorRun(port: ReanchorRunPort): ReanchorRun {
  return { ...port, votes: makeReanchorVotes() };
}

/**
 * Reconcile one restarted conversation position and start or finish its
 * re-anchor.
 * @param run Recovery run whose position is ready.
 * @param membership Fixed membership of the conversation.
 * @returns Completion after re-anchor progress is durably queued.
 */
export function positionReady(
  run: ReanchorRun,
  membership: VerifiedMembership,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.sync(() => {
    run.votes.positionsReady.add(membership.descriptor.conversationId);
  }).pipe(Effect.zipRight(finishRestartedPosition(run, membership)));
}

/**
 * Accept one stable re-anchor vote from a verified outer member envelope.
 * @param run Recovery run the vote targets.
 * @param ingress Authenticated Router delivery containing the outer envelope.
 * @param message Stable self-addressed vote evidence.
 * @returns Whether the vote was accepted or safely ignored.
 */
export function acceptReanchorVote(
  run: ReanchorRun,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessageValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return acceptReanchorVoteEffect(run, ingress, message).pipe(
    Effect.withSpan("acceptReanchorVote"),
  );
}

/**
 * Accept one completed threshold re-anchor from a fixed conversation member.
 * @param run Recovery run the completion targets.
 * @param ingress Authenticated Router delivery containing the completion.
 * @param completed Complete re-anchor and signer-attributed certificate.
 * @returns Whether the completion was accepted or safely ignored.
 */
export function acceptCompletedReanchor(
  run: ReanchorRun,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  completed: CompletedReanchorValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return acceptCompletedReanchorEffect(run, ingress, completed).pipe(
    Effect.withSpan("acceptCompletedReanchor"),
  );
}

function finishRestartedPosition(
  run: ReanchorRun,
  membership: VerifiedMembership,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const conversationId = membership.descriptor.conversationId;
  if (!run.reanchoring.has(conversationId)) {
    return finishAnchoredPosition(run, membership);
  }
  return durablePosition(run.runtime, conversationId).pipe(
    Effect.flatMap(({ recovery, position }) => {
      if (position === undefined) {
        return Effect.fail(persistenceFailure());
      }
      if (position.headRecordHash === undefined) {
        if (currentAnchorForRecovery(run, conversationId) !== undefined) {
          return run.markRecovered(conversationId);
        }
        return restartEmptyPosition({
          runtime: run.runtime,
          routerInstanceId: run.routerInstanceId,
          membership,
          recovery,
          position,
        }).pipe(Effect.zipRight(run.markRecovered(conversationId)));
      }
      return Schema.decodeUnknown(RecordHash)(position.headRecordHash).pipe(
        Effect.mapError(persistenceFailure),
        Effect.flatMap((head) =>
          observedHeadsResolve(run.votes, recovery, conversationId, head)
            ? advanceRestartedPosition({
                run,
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
  readonly run: ReanchorRun;
  readonly membership: VerifiedMembership;
  readonly recovery: EndpointRecovery;
  readonly position: EndpointRecovery["positions"][number];
  readonly head: RecordHashValue;
}

function advanceRestartedPosition(
  input: RestartedPositionInput,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const { head, membership, position, recovery, run } = input;
  const conversationId = membership.descriptor.conversationId;
  if (currentAnchorForRecovery(run, conversationId) !== undefined) {
    return finishAnchoredPosition(run, membership);
  }
  if (hasStagedSuccessor(recovery, conversationId, head)) {
    return Effect.void;
  }
  return replayReanchorVotes(run, membership, conversationId, head).pipe(
    Effect.zipRight(
      run.isRecovered(conversationId)
        ? Effect.void
        : proposeReanchor(run, membership, position),
    ),
  );
}

/**
 * Finish a conversation already anchored to the recovery Router instance.
 *
 * Catch-up alone reconciles it. A retained completed re-anchor for that
 * instance is relayed again so members still recovering can finish.
 * @param run Recovery run reconciling the conversation.
 * @param membership Fixed membership of the reconciled conversation.
 * @returns Completion after the conversation is marked recovered.
 */
function finishAnchoredPosition(
  run: ReanchorRun,
  membership: VerifiedMembership,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const conversationId = membership.descriptor.conversationId;
  const anchor = currentAnchorForRecovery(run, conversationId);
  const relay =
    anchor?.kind === "completed_reanchor"
      ? run.queue(membership, { kind: "direct", packet: anchor })
      : Effect.void;
  return relay.pipe(Effect.zipRight(run.markRecovered(conversationId)));
}

function observedHeadsResolve(
  votes: ReanchorVotes,
  recovery: EndpointRecovery,
  conversationId: ConversationIdValue,
  head: RecordHashValue,
): boolean {
  const observed = votes.observedHeads.get(conversationId);
  if (observed === undefined) {
    return true;
  }
  return [...observed].every((candidate) =>
    observedHeadIsResolved(recovery, conversationId, candidate, head),
  );
}

/**
 * A daemon restart does not replace a verified anchor for the same Router.
 * @param run Recovery with an authenticated Router instance.
 * @param conversationId Fixed conversation whose anchor is being reconciled.
 * @returns The retained anchor only when it already names the current Router.
 */
function currentAnchorForRecovery(
  run: ReanchorRun,
  conversationId: ConversationIdValue,
): RouterAnchor | undefined {
  const anchor = run.runtime.conversations.get(conversationId)?.currentAnchor;
  if (anchor === undefined) {
    return undefined;
  }
  return anchorRouterInstanceId(anchor) === run.routerInstanceId
    ? anchor
    : undefined;
}

function acceptReanchorVoteEffect(
  run: ReanchorRun,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessageValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return decodeCanonical(EvidenceStatement, message.body).pipe(
    Effect.flatMap((statement) => {
      if (statement.kind !== "reanchor_vote") {
        return Effect.succeed(ignoredDisposition);
      }
      const membership = run.membership(statement.reanchor.conversationId);
      if (membership === undefined) {
        return Effect.succeed(ignoredDisposition);
      }
      return verifyInboundVote(run, ingress, message, membership);
    }),
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.succeed(ignoredDisposition),
    ),
    Effect.mapError(persistenceFailure),
  );
}

function verifyInboundVote(
  run: ReanchorRun,
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
      return processReanchorVote(run, membership, {
        message: verified.message,
        statement: verified.statement,
      }).pipe(
        Effect.map((taken) =>
          taken ? acceptedDisposition : ignoredDisposition,
        ),
      );
    }),
    Effect.mapError(persistenceFailure),
  );
}

function acceptCompletedReanchorEffect(
  run: ReanchorRun,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  completed: CompletedReanchorValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const membership = run.membership(completed.reanchor.conversationId);
  if (membership === undefined || !completionTargetsRecovery(run, completed)) {
    return Effect.succeed(ignoredDisposition);
  }
  return verifyOuterMessage({ message: ingress.message, membership }).pipe(
    Effect.zipRight(verifyCompletedReanchor({ completed, membership })),
    Effect.zipRight(processCompletedVotes(run, membership, completed)),
    Effect.as(acceptedDisposition),
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.succeed(ignoredDisposition),
    ),
    Effect.mapError(persistenceFailure),
  );
}

function completionTargetsRecovery(
  run: ReanchorRun,
  completed: CompletedReanchorValue,
): boolean {
  return (
    run.reason === "router_restarted" &&
    completed.reanchor.routerInstanceId === run.routerInstanceId
  );
}

function processCompletedVotes(
  run: ReanchorRun,
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
          return processReanchorVote(run, membership, {
            message: verified.message,
            statement: verified.statement,
          }).pipe(Effect.asVoid);
        }),
        Effect.mapError(persistenceFailure),
      ),
    { concurrency: 1, discard: true },
  );
}

/**
 * Takes a vote into the active recovery run when it targets that run's Router
 * restart and names the anchor its body hashes to. A vote outside a restart,
 * or after the run has ended, changes nothing, so the caller reports it as
 * ignored.
 * @param run Recovery run the vote targets.
 * @param membership Verified membership of the vote's conversation.
 * @param vote Verified re-anchor vote and its signed message.
 * @returns Whether the run took the vote.
 */
function processReanchorVote(
  run: ReanchorRun,
  membership: VerifiedMembership,
  vote: PendingReanchorVote,
): Effect.Effect<boolean, RouterWorkerPersistenceError> {
  if (!run.isActive() || !voteTargetsRecovery(run, membership, vote)) {
    return Effect.succeed(false);
  }
  return hashAnchor(vote.statement.reanchor).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((expectedHash) => {
      if (expectedHash !== vote.statement.anchorHash) {
        return Effect.succeed(false);
      }
      return rememberReanchorVote(run.votes, vote).pipe(
        Effect.zipRight(
          run.votes.positionsReady.has(vote.statement.reanchor.conversationId)
            ? processReadyReanchorVote(run, membership, vote)
            : Effect.void,
        ),
        Effect.as(true),
      );
    }),
  );
}

function voteTargetsRecovery(
  run: ReanchorRun,
  membership: VerifiedMembership,
  vote: PendingReanchorVote,
): boolean {
  const body = vote.statement.reanchor;
  if (
    run.reason !== "router_restarted" ||
    !run.reanchoring.has(body.conversationId)
  ) {
    return false;
  }
  return (
    body.membershipHash === membership.hash &&
    body.routerInstanceId === run.routerInstanceId
  );
}

function processReadyReanchorVote(
  run: ReanchorRun,
  membership: VerifiedMembership,
  vote: PendingReanchorVote,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const body = vote.statement.reanchor;
  return durablePosition(run.runtime, body.conversationId).pipe(
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
            run,
            recovery,
            body,
            head,
            anchor,
          }),
        ),
        Effect.flatMap((ready) =>
          ready ? certifyReanchorVote(run, membership, vote) : Effect.void,
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
  readonly run: ReanchorRun;
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
  const { body, head, recovery, run } = input;
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
    run.votes.positionsReady.delete(body.conversationId);
  }).pipe(
    Effect.zipRight(run.requestCatchUp(body.conversationId)),
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
  run: ReanchorRun,
  membership: VerifiedMembership,
  position: EndpointRecovery["positions"][number],
): Effect.Effect<void, RouterWorkerPersistenceError> {
  if (
    !run.isActive() ||
    run.reason !== "router_restarted" ||
    position.headRecordHash === undefined
  ) {
    return Effect.fail(persistenceFailure());
  }
  return makeReanchorBody(
    run,
    membership,
    position,
    position.headRecordHash,
  ).pipe(
    Effect.flatMap((body) =>
      hashAnchor(body).pipe(
        Effect.mapError(persistenceFailure),
        Effect.flatMap((anchorHash) =>
          proposeReanchorCandidate(run, membership, body, anchorHash),
        ),
      ),
    ),
  );
}

function makeReanchorBody(
  run: ReanchorRun,
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
    routerInstanceId: run.routerInstanceId,
  }).pipe(Effect.mapError(persistenceFailure));
}

function proposeReanchorCandidate(
  run: ReanchorRun,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return stageReanchorCandidate(run, membership, body, anchorHash).pipe(
    Effect.flatMap((staged) =>
      staged ? Effect.void : Effect.fail(persistenceFailure()),
    ),
    Effect.zipRight(voteAndComplete(run, membership, body, anchorHash)),
  );
}

function certifyReanchorVote(
  run: ReanchorRun,
  membership: VerifiedMembership,
  vote: PendingReanchorVote,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const body = vote.statement.reanchor;
  const anchorHash = vote.statement.anchorHash;
  return stageReanchorCandidate(run, membership, body, anchorHash).pipe(
    Effect.flatMap((staged) =>
      staged ? Effect.void : Effect.fail(persistenceFailure()),
    ),
    Effect.zipRight(persistReanchorVote(run.runtime, vote)),
    Effect.zipRight(voteAndComplete(run, membership, body, anchorHash)),
  );
}

function voteAndComplete(
  run: ReanchorRun,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return ensureLocalReanchorVote(run, membership, body, anchorHash).pipe(
    Effect.zipRight(
      completeReanchorAtThreshold(run, membership, body, anchorHash),
    ),
  );
}

function stageReanchorCandidate(
  run: ReanchorRun,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<boolean, RouterWorkerPersistenceError> {
  return durablePosition(run.runtime, body.conversationId).pipe(
    Effect.flatMap(({ recovery, position }) => {
      if (
        !run.isActive() ||
        position === undefined ||
        position.headRecordHash === undefined ||
        !candidateMatchesPosition(run, membership, position, body)
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
      return persistReanchorCandidate(run.runtime, body, anchorHash);
    }),
    Effect.mapError(persistenceFailure),
  );
}

function candidateMatchesPosition(
  run: ReanchorRun,
  membership: VerifiedMembership,
  position: EndpointRecovery["positions"][number],
  body: ReanchorBodyValue,
): boolean {
  if (
    run.reason !== "router_restarted" ||
    position.headRecordHash === undefined
  ) {
    return false;
  }
  return [
    run.votes.positionsReady.has(body.conversationId),
    body.membershipHash === membership.hash,
    body.previousAnchorHash === position.currentAnchorHash,
    body.selectedRecordHash === position.headRecordHash,
    body.routerInstanceId === run.routerInstanceId,
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

function ensureLocalReanchorVote(
  run: ReanchorRun,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  if (!run.isActive()) {
    return Effect.fail(persistenceFailure());
  }
  const localAgentId = run.runtime.input.localAgentCard.agentId;
  const statement = localReanchorVoteStatement(run.runtime, body, anchorHash);
  return decodeReanchorVotes(run.runtime, membership, body, anchorHash).pipe(
    Effect.flatMap((votes) => {
      const message = votes.find((vote) => vote.senderAgentId === localAgentId);
      if (message === undefined) {
        return createLocalReanchorVote(run, membership, statement);
      }
      const vote: PendingReanchorVote = { message, statement };
      return reanchorVoteIsRemembered(run.votes, vote)
        ? Effect.void
        : run
            .queue(membership, { kind: "evidence", message })
            .pipe(Effect.zipRight(rememberReanchorVote(run.votes, vote)));
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

function createLocalReanchorVote(
  run: ReanchorRun,
  membership: VerifiedMembership,
  statement: PendingReanchorVote["statement"],
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return signEvidenceMessage({
    statement,
    agentCard: run.runtime.input.localAgentCard,
    signingAuthority: run.runtime.input.signingAuthority,
  }).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((message) => {
      const vote: PendingReanchorVote = { message, statement };
      return persistReanchorVote(run.runtime, vote).pipe(
        Effect.zipRight(run.queue(membership, { kind: "evidence", message })),
        Effect.zipRight(rememberReanchorVote(run.votes, vote)),
      );
    }),
  );
}

function completeReanchorAtThreshold(
  run: ReanchorRun,
  membership: VerifiedMembership,
  body: ReanchorBodyValue,
  anchorHash: AnchorHashValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  if (run.isActive() && run.isRecovered(body.conversationId)) {
    return Effect.void;
  }
  return decodeReanchorVotes(run.runtime, membership, body, anchorHash).pipe(
    Effect.flatMap((votes) =>
      votes.length < quorumThreshold(membership.members.length)
        ? Effect.succeed(undefined)
        : assembleCompletedReanchor(body, anchorHash, votes),
    ),
    Effect.flatMap((completed) =>
      completed === undefined
        ? Effect.void
        : finalizeCompletedReanchor(run, membership, completed),
    ),
  );
}

function finalizeCompletedReanchor(
  run: ReanchorRun,
  membership: VerifiedMembership,
  completed: CompletedReanchorValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return verifyCompletedReanchor({ completed, membership }).pipe(
    Effect.mapError(persistenceFailure),
    Effect.zipRight(persistCompletedReanchor(run.runtime, completed)),
    Effect.zipRight(
      run.queue(membership, { kind: "direct", packet: completed }),
    ),
    Effect.zipRight(run.markRecovered(completed.reanchor.conversationId)),
  );
}

function replayReanchorVotes(
  run: ReanchorRun,
  membership: VerifiedMembership,
  conversationId: ConversationIdValue,
  headRecordHash: RecordHashValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  const candidates = run.isActive()
    ? run.votes.pendingVotes.get(conversationId)
    : undefined;
  if (candidates === undefined) {
    return Effect.void;
  }
  return Effect.forEach(
    candidates.values(),
    (votes) => replayCandidateVotes(run, membership, votes, headRecordHash),
    { concurrency: 1, discard: true },
  );
}

function replayCandidateVotes(
  run: ReanchorRun,
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
        ? processReanchorVote(run, membership, vote).pipe(Effect.asVoid)
        : Effect.void,
    { concurrency: 1, discard: true },
  );
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}
