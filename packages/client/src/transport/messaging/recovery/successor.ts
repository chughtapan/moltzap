/**
 * @file Staged successors during recovery: a record some members staged and
 * voted durable before a Router discontinuity, extending the head a
 * recovering conversation holds. Recovery certifies such a successor at
 * `q(n)` durability votes, and a member that did not stage it converts to it:
 * it stages the record and votes for it once enough members vouch for it.
 */

import { type AgentId, SignedMessage } from "@moltzap/identity";
import { Effect, Schema } from "effect";
import type {
  RouterIngressDisposition,
  RouterWorkerIngress,
  RouterWorkerPersistenceError,
} from "../../router/index.js";
import type {
  EngineActionFold,
  EngineConversation,
  EngineRuntime,
} from "../runtime/index.js";
import {
  type ActionCertifiedRecord,
  type AnchorHash as AnchorHashValue,
  ClientRepresentationError,
  type ConversationId as ConversationIdValue,
  type DecodedOuterBody,
  type EvidenceStatement,
  hashAnchor,
  quorumThreshold,
  type RecordHash as RecordHashValue,
  type VerifiedMembership,
  verifyActionCertifiedRecord,
  verifyOuterMessage,
  verifyStableEvidence,
} from "../../wire/index.js";

/**
 * A successor a member has sent while this endpoint has not staged it: its
 * action-certified record once one arrives, and the members' durability votes
 * for it, keyed by voter.
 */
interface PendingSuccessor {
  record?: RouterWorkerIngress<DecodedOuterBody>;
  readonly votes: Map<AgentId, RouterWorkerIngress<DecodedOuterBody>>;
  /** Set once the endpoint has tried to stage the record, which it does once. */
  settled: boolean;
}

/** A recovery run's pending successors, keyed by record hash. */
export type PendingSuccessors = Map<RecordHashValue, PendingSuccessor>;

/** What staged-successor handling needs from the recovery run it belongs to. */
export interface SuccessorRun {
  readonly runtime: EngineRuntime;
  readonly pending: PendingSuccessors;
  /** The run's verified membership of a conversation. */
  readonly membership: (
    conversationId: ConversationIdValue,
  ) => VerifiedMembership | undefined;
  /** Whether the run re-anchors the conversation after a Router restart. */
  readonly reanchoring: (conversationId: ConversationIdValue) => boolean;
  /**
   * Continue a conversation's recovery after the protocol phases took a
   * staged successor's traffic: catch up from a newly certified head.
   */
  readonly certified: (
    conversationId: ConversationIdValue,
    previousHead?: RecordHashValue,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
}

const ignoredDisposition: RouterIngressDisposition = "ignored";

/**
 * Take a member's action-certified record for a recovering conversation when
 * it extends the conversation's head under its current anchor. Outside a
 * re-anchor the record alone is enough, so the protocol phases stage it and
 * vote for it at once. During a re-anchor this endpoint converts to it only
 * once more than `n − q(n)` members have voted it durable; until then it
 * holds the record.
 * @param run Recovery run that holds the conversation.
 * @param ingress Verified Router delivery carrying the record.
 * @param record The member's action-certified record.
 * @returns Whether the record was taken or ignored.
 */
export function acceptSuccessorRecord(
  run: SuccessorRun,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  record: ActionCertifiedRecord,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const conversationId = record.recordCore.action.conversationId;
  const conversation = run.runtime.conversations.get(conversationId);
  const membership = run.membership(conversationId);
  if (
    conversation === undefined ||
    membership === undefined ||
    run.runtime.recordFolds.has(record.recordHash)
  ) {
    return Effect.succeed(ignoredDisposition);
  }
  return Effect.gen(function* () {
    if (!(yield* extendsHead(conversation, record))) {
      return ignoredDisposition;
    }
    yield* verifyOuterMessage({ message: ingress.message, membership });
    const verified = yield* verifyActionCertifiedRecord({
      record,
      registrySignerPublicKey: run.runtime.input.registrySignerPublicKey,
    });
    if (verified.membership.hash !== membership.hash) {
      return ignoredDisposition;
    }
    if (!run.reanchoring(conversationId)) {
      return yield* certifyThroughPhases(run, conversationId, [ingress]);
    }
    const pending = pendingFor(run.pending, record.recordHash);
    pending.record = ingress;
    return yield* maybeConvert(run, membership, record.recordHash).pipe(
      Effect.as<RouterIngressDisposition>("accepted"),
    );
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.succeed(ignoredDisposition),
    ),
    Effect.withSpan("acceptSuccessorRecord"),
  );
}

/**
 * Take a member's durability vote for a recovering conversation's staged
 * successor. A successor this endpoint has staged takes the vote in the
 * protocol phases, which certify it at `q(n)` votes. During a re-anchor, a
 * vote for a successor it has not staged is held toward converting to it.
 * @param run Recovery run that holds the conversation.
 * @param ingress Verified Router delivery carrying the vote.
 * @param statement The vote's decoded statement.
 * @returns Whether the vote was taken or ignored.
 */
export function acceptSuccessorVote(
  run: SuccessorRun,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  statement: Extract<EvidenceStatement, { readonly kind: "durability_vote" }>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const { conversationId, recordHash } = statement;
  const conversation = run.runtime.conversations.get(conversationId);
  const membership = run.membership(conversationId);
  if (conversation === undefined || membership === undefined) {
    return Effect.succeed(ignoredDisposition);
  }
  const fold = run.runtime.recordFolds.get(recordHash);
  if (fold !== undefined) {
    return stagedSuccessorOf(conversation, fold)
      ? certifyThroughPhases(run, conversationId, [ingress])
      : Effect.succeed(ignoredDisposition);
  }
  if (!run.reanchoring(conversationId)) {
    return Effect.succeed(ignoredDisposition);
  }
  return holdVote(run, membership, ingress).pipe(
    Effect.flatMap((held) =>
      held
        ? maybeConvert(run, membership, recordHash).pipe(
            Effect.as<RouterIngressDisposition>("accepted"),
          )
        : Effect.succeed(ignoredDisposition),
    ),
  );
}

/**
 * Verify a durability vote from another member and hold it for its record.
 * @param run Recovery run that holds the conversation.
 * @param membership Verified membership of the vote's conversation.
 * @param ingress Verified Router delivery carrying the vote.
 * @returns Whether the vote was verified and held.
 */
function holdVote(
  run: SuccessorRun,
  membership: VerifiedMembership,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<boolean> {
  if (ingress.payload.kind !== "evidence") {
    return Effect.succeed(false);
  }
  const { message } = ingress.payload;
  return Effect.gen(function* () {
    yield* verifyOuterMessage({ message: ingress.message, membership });
    const verified = yield* verifyStableEvidence({
      representation: yield* encodeEvidence(message),
      membership,
    });
    const { statement } = verified;
    if (
      statement.kind !== "durability_vote" ||
      statement.membershipHash !== membership.hash ||
      statement.signerAgentId === run.runtime.input.localAgentCard.agentId
    ) {
      return false;
    }
    pendingFor(run.pending, statement.recordHash).votes.set(
      statement.signerAgentId,
      ingress,
    );
    return true;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(false)),
  );
}

/**
 * Convert to a pending successor once its record is held and more than
 * `n − q(n)` other members have voted it durable: more than the members
 * that can be faulty, so at least one correct member staged it. The protocol
 * phases stage the record and sign this endpoint's vote, then take the held
 * votes. The store refuses the record when this endpoint has staged a
 * re-anchor candidate away from its anchor, and the endpoint tries once.
 * @param run Recovery run that holds the conversation.
 * @param membership Verified membership of the successor's conversation.
 * @param recordHash The pending successor.
 * @returns Completion once the endpoint has converted or keeps waiting.
 */
function maybeConvert(
  run: SuccessorRun,
  membership: VerifiedMembership,
  recordHash: RecordHashValue,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.suspend(() => {
    const pending = run.pending.get(recordHash);
    const memberCount = membership.members.length;
    const vouching = memberCount - quorumThreshold(memberCount) + 1;
    if (
      pending?.record === undefined ||
      pending.settled ||
      pending.votes.size < vouching
    ) {
      return Effect.void;
    }
    pending.settled = true;
    return certifyThroughPhases(run, membership.descriptor.conversationId, [
      pending.record,
      ...pending.votes.values(),
    ]).pipe(Effect.asVoid);
  });
}

/**
 * Hand a staged successor's traffic to the protocol phases in order, then let
 * the run catch up from the head they certify.
 * @param run Recovery run that holds the conversation.
 * @param conversationId Conversation the traffic is for.
 * @param deliveries Verified Router deliveries: a record, then votes.
 * @returns The first delivery's disposition.
 */
function certifyThroughPhases(
  run: SuccessorRun,
  conversationId: ConversationIdValue,
  deliveries: ReadonlyArray<RouterWorkerIngress<DecodedOuterBody>>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const { runtime } = run;
  const previousHead =
    runtime.conversations.get(conversationId)?.head?.recordHash;
  return Effect.forEach(
    deliveries,
    (delivery) => runtime.phases.acceptIngress(runtime, delivery),
    { concurrency: 1 },
  ).pipe(
    Effect.tap(() => run.certified(conversationId, previousHead)),
    Effect.map((dispositions) => dispositions[0] ?? ignoredDisposition),
  );
}

function stagedSuccessorOf(
  conversation: EngineConversation,
  fold: EngineActionFold,
): boolean {
  return (
    fold.certifiedRecord === undefined &&
    fold.action.kind === "POST" &&
    fold.action.previousRecordHash === conversation.head?.recordHash
  );
}

function extendsHead(
  conversation: EngineConversation,
  record: ActionCertifiedRecord,
): Effect.Effect<boolean, ClientRepresentationError> {
  const action = record.recordCore.action;
  if (
    action.kind !== "POST" ||
    action.previousRecordHash !== conversation.head?.recordHash
  ) {
    return Effect.succeed(false);
  }
  return currentAnchorHash(conversation).pipe(
    Effect.map((anchorHash) => anchorHash === action.anchorHash),
  );
}

function currentAnchorHash(
  conversation: EngineConversation,
): Effect.Effect<AnchorHashValue, ClientRepresentationError> {
  return conversation.currentAnchor.kind === "genesis_anchor_body"
    ? hashAnchor(conversation.currentAnchor)
    : Effect.succeed(conversation.currentAnchor.anchorHash);
}

function encodeEvidence(
  message: SignedMessage,
): Effect.Effect<unknown, ClientRepresentationError> {
  return Schema.encode(SignedMessage)(message).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new ClientRepresentationError()),
    ),
  );
}

function pendingFor(
  pending: PendingSuccessors,
  recordHash: RecordHashValue,
): PendingSuccessor {
  const retained = pending.get(recordHash);
  if (retained !== undefined) {
    return retained;
  }
  const created: PendingSuccessor = { votes: new Map(), settled: false };
  pending.set(recordHash, created);
  return created;
}
