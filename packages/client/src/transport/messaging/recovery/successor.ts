/**
 * @file Staged successors in recovery: a record some members staged and voted
 * durable before a Router discontinuity, extending the head a recovering
 * conversation holds. A holder hands it to members instead of saying nothing
 * follows its head; recovery certifies it at `q(n)` durability votes; and a
 * member that did not stage it converts to it, staging the record and voting
 * for it once enough members vouch for it.
 */

import type { AgentId, SignedMessage } from "@moltzap/identity";
import { Effect, Schema } from "effect";
import type { StagedRecord } from "../../../store/index.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
} from "../../router/index.js";
import type {
  EngineActionFold,
  EngineConversation,
  EngineRuntime,
} from "../runtime/index.js";
import {
  type ActionCertifiedRecord,
  type ClientRepresentationError,
  type ConversationId as ConversationIdValue,
  type DecodedOuterBody,
  type EvidenceStatement,
  quorumThreshold,
  RecordHash,
  type RecordHash as RecordHashValue,
  type VerifiedMembership,
  verifyActionCertifiedRecord,
  verifyDeliveredEvidence,
  verifyOuterMessage,
} from "../../wire/index.js";
import {
  makeActionCertifiedRecord,
  recordAnchorHash,
} from "../history/index.js";

/** A held delivery and the record it carries or votes for. */
interface HeldDelivery {
  readonly recordHash: RecordHashValue;
  readonly ingress: RouterWorkerIngress<DecodedOuterBody>;
}

/**
 * What a re-anchoring member holds toward converting to a conversation's
 * successor: the one verified action-certified record extending its head,
 * and the first durability vote each other member sent. A correct member
 * votes for one successor of a head, so one vote per member is enough, and a
 * faulty member cannot grow the hold.
 */
interface PendingSuccessor {
  record?: HeldDelivery;
  readonly votes: Map<AgentId, HeldDelivery>;
  /** Set once the endpoint has tried to stage the held record. */
  settled: boolean;
}

/** A recovery run's pending successors, one per conversation. */
export type PendingSuccessors = Map<ConversationIdValue, PendingSuccessor>;

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
  /** Catch the conversation up again from a newly certified head. */
  readonly armCatchUp: (
    conversationId: ConversationIdValue,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
}

const ignoredDisposition: RouterIngressDisposition = "ignored";

/**
 * Send members the staged, uncertified successor this endpoint holds and its
 * durability vote for it, both taken from the record's fold. A holder sends
 * them in place of an `incomplete` catch-up answer at the successor's
 * predecessor, and again when its own position is ready, since it votes for
 * no re-anchor there.
 * @param runtime Engine whose fold holds the record.
 * @param queue How the caller signs and sends a body to the members.
 * @param membership Verified membership of the record's conversation.
 * @param staged The staged record row.
 * @returns Completion once the record and the vote are queued.
 */
export function queueStagedSuccessor(
  runtime: EngineRuntime,
  queue: (
    membership: VerifiedMembership,
    body: DecodedOuterBody,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>,
  membership: VerifiedMembership,
  staged: StagedRecord,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Schema.decodeUnknown(RecordHash)(staged.recordHash).pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((recordHash) => {
      const fold = runtime.recordFolds.get(recordHash);
      return fold === undefined
        ? Effect.succeed([])
        : successorBodies(runtime, fold).pipe(
            Effect.mapError(persistenceFailure),
          );
    }),
    Effect.flatMap((bodies) =>
      Effect.forEach(bodies, (body) => queue(membership, body), {
        concurrency: 1,
        discard: true,
      }),
    ),
  );
}

/**
 * Take a member's action-certified record for a recovering conversation when
 * it extends the conversation's head. Outside a re-anchor the record alone
 * is enough, so the protocol phases verify it, stage it and vote for it at
 * once. During a re-anchor this endpoint verifies and holds it, and converts
 * to it only once more than `n − q(n)` members have voted it durable.
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
    run.runtime.recordFolds.has(record.recordHash) ||
    !extendsHead(conversation, record)
  ) {
    return Effect.succeed(ignoredDisposition);
  }
  if (!run.reanchoring(conversationId)) {
    return certifyThroughPhases(run, conversationId, [ingress]);
  }
  const pending = pendingFor(run.pending, conversationId);
  if (pending.settled || pending.record?.recordHash === record.recordHash) {
    return Effect.succeed(ignoredDisposition);
  }
  return verifyHeldRecord(run, membership, ingress, record).pipe(
    Effect.flatMap((verified) => {
      if (!verified) {
        return Effect.succeed(ignoredDisposition);
      }
      pending.record = { recordHash: record.recordHash, ingress };
      return maybeConvert(run, membership).pipe(
        Effect.as<RouterIngressDisposition>("accepted"),
      );
    }),
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
 * @param vote The vote's evidence message and its decoded statement.
 * @param vote.message The vote's evidence message.
 * @param vote.statement The vote's decoded statement.
 * @returns Whether the vote was taken or ignored.
 */
export function acceptSuccessorVote(
  run: SuccessorRun,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  vote: Readonly<{
    message: SignedMessage;
    statement: Extract<EvidenceStatement, { readonly kind: "durability_vote" }>;
  }>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const { conversationId, recordHash, signerAgentId } = vote.statement;
  const conversation = run.runtime.conversations.get(conversationId);
  const membership = run.membership(conversationId);
  if (conversation === undefined || membership === undefined) {
    return Effect.succeed(ignoredDisposition);
  }
  const fold = run.runtime.recordFolds.get(recordHash);
  if (fold !== undefined) {
    return stagedSuccessorOf(conversation, fold) &&
      !fold.durabilityEvidence.has(signerAgentId)
      ? certifyThroughPhases(run, conversationId, [ingress])
      : Effect.succeed(ignoredDisposition);
  }
  const pending = pendingFor(run.pending, conversationId);
  if (!run.reanchoring(conversationId) || pending.votes.has(signerAgentId)) {
    return Effect.succeed(ignoredDisposition);
  }
  return verifyHeldVote(run, membership, ingress, vote.message).pipe(
    Effect.flatMap((verified) => {
      if (!verified) {
        return Effect.succeed(ignoredDisposition);
      }
      pending.votes.set(signerAgentId, { recordHash, ingress });
      return maybeConvert(run, membership).pipe(
        Effect.as<RouterIngressDisposition>("accepted"),
      );
    }),
  );
}

function verifyHeldRecord(
  run: SuccessorRun,
  membership: VerifiedMembership,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  record: ActionCertifiedRecord,
): Effect.Effect<boolean> {
  return verifyOuterMessage({ message: ingress.message, membership }).pipe(
    Effect.zipRight(
      verifyActionCertifiedRecord({
        record,
        registrySignerPublicKey: run.runtime.input.registrySignerPublicKey,
      }),
    ),
    Effect.map((verified) => verified.membership.hash === membership.hash),
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(false)),
  );
}

function verifyHeldVote(
  run: SuccessorRun,
  membership: VerifiedMembership,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessage,
): Effect.Effect<boolean> {
  return verifyDeliveredEvidence({
    outer: ingress.message,
    evidence: message,
    membership,
  }).pipe(
    Effect.map(
      ({ statement }) =>
        statement.kind === "durability_vote" &&
        statement.membershipHash === membership.hash &&
        statement.signerAgentId !== run.runtime.input.localAgentCard.agentId,
    ),
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(false)),
  );
}

/**
 * Convert to the held successor once more than `n − q(n)` other members have
 * voted it durable: more than the members that can be faulty, so at least one
 * correct member staged it. The protocol phases stage the record and sign
 * this endpoint's vote, then take the held votes. The store refuses the
 * record when this endpoint has staged a re-anchor candidate away from its
 * anchor, and the endpoint tries once.
 * @param run Recovery run that holds the conversation.
 * @param membership Verified membership of the successor's conversation.
 * @returns Completion once the endpoint has converted or keeps waiting.
 */
function maybeConvert(
  run: SuccessorRun,
  membership: VerifiedMembership,
): Effect.Effect<void, RouterWorkerPersistenceError> {
  return Effect.suspend(() => {
    const conversationId = membership.descriptor.conversationId;
    const pending = run.pending.get(conversationId);
    const record = pending?.record;
    if (pending === undefined || record === undefined || pending.settled) {
      return Effect.void;
    }
    const votes = [...pending.votes.values()].filter(
      (vote) => vote.recordHash === record.recordHash,
    );
    const memberCount = membership.members.length;
    if (votes.length < memberCount - quorumThreshold(memberCount) + 1) {
      return Effect.void;
    }
    pending.settled = true;
    return certifyThroughPhases(run, conversationId, [
      record.ingress,
      ...votes.map((vote) => vote.ingress),
    ]).pipe(Effect.asVoid);
  });
}

/**
 * Hand a staged successor's traffic to the protocol phases in order. When
 * they certify it, the conversation's head moves: its held successor traffic
 * is spent, and catch-up starts again from the new head.
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
  const headBefore =
    runtime.conversations.get(conversationId)?.head?.recordHash;
  return Effect.forEach(
    deliveries,
    (delivery) => runtime.phases.acceptIngress(runtime, delivery),
    { concurrency: 1 },
  ).pipe(
    Effect.tap(() => {
      if (
        runtime.conversations.get(conversationId)?.head?.recordHash ===
        headBefore
      ) {
        return Effect.void;
      }
      run.pending.delete(conversationId);
      return run.armCatchUp(conversationId);
    }),
    Effect.map((dispositions) => dispositions[0] ?? ignoredDisposition),
  );
}

function successorBodies(
  runtime: EngineRuntime,
  fold: EngineActionFold,
): Effect.Effect<readonly DecodedOuterBody[], ClientRepresentationError> {
  return recordAnchorHash(fold).pipe(
    Effect.flatMap((anchorHash) => makeActionCertifiedRecord(fold, anchorHash)),
    Effect.map((record): readonly DecodedOuterBody[] => {
      const vote = fold.durabilityEvidence.get(
        runtime.input.localAgentCard.agentId,
      );
      return [
        { kind: "direct", packet: record },
        ...(vote === undefined
          ? []
          : [{ kind: "evidence" as const, message: vote }]),
      ];
    }),
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
): boolean {
  const action = record.recordCore.action;
  return (
    action.kind === "POST" &&
    action.previousRecordHash === conversation.head?.recordHash
  );
}

function pendingFor(
  pending: PendingSuccessors,
  conversationId: ConversationIdValue,
): PendingSuccessor {
  const retained = pending.get(conversationId);
  if (retained !== undefined) {
    return retained;
  }
  const created: PendingSuccessor = { votes: new Map(), settled: false };
  pending.set(conversationId, created);
  return created;
}

function persistenceFailure(): RouterWorkerPersistenceError {
  return new RouterWorkerPersistenceError();
}
