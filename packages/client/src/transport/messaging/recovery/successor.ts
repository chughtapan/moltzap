/**
 * @file Staged successors in recovery: a record some members staged and voted
 * durable before a Router discontinuity, extending the head a recovering
 * conversation holds. Holders send it in their catch-up answers. Recovery
 * certifies it at `q(n)` durability votes, and a member that did not stage it
 * converts to it, staging the record and voting for it once enough members
 * vouch for it.
 */

import type { AgentId, SignedMessage } from "@moltzap/identity";
import { Effect } from "effect";
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
  type ActionCore,
  type ConversationId as ConversationIdValue,
  type DecodedOuterBody,
  type EvidenceStatement,
  quorumThreshold,
  type RecordHash as RecordHashValue,
  type VerifiedMembership,
  verifyActionCertifiedRecord,
  verifyDeliveredEvidence,
  verifyOuterMessage,
} from "../../wire/index.js";

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

/** What staged-successor handling needs from the recovery run it belongs to. */
export interface SuccessorRun {
  readonly runtime: EngineRuntime;
  /** The successor each re-anchoring conversation holds toward converting. */
  readonly pending: Map<ConversationIdValue, PendingSuccessor>;
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

const acceptedDisposition: RouterIngressDisposition = "accepted";
const ignoredDisposition: RouterIngressDisposition = "ignored";

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
  const { action } = record.recordCore;
  const { conversationId } = action;
  const membership = membershipExtendedBy(run, action);
  if (
    membership === undefined ||
    run.runtime.recordFolds.has(record.recordHash)
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
  return holdTowardConversion(
    run,
    membership,
    verifyHeldRecord(run, membership, ingress, record),
    () => {
      pending.record = { recordHash: record.recordHash, ingress };
    },
  ).pipe(Effect.withSpan("acceptSuccessorRecord"));
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
    return acceptStagedSuccessorVote(
      run,
      { conversation, fold },
      ingress,
      vote.statement,
    );
  }
  if (!run.reanchoring(conversationId)) {
    return Effect.succeed(ignoredDisposition);
  }
  const pending = pendingFor(run.pending, conversationId);
  if (pending.settled || pending.votes.has(signerAgentId)) {
    return Effect.succeed(ignoredDisposition);
  }
  return holdTowardConversion(
    run,
    membership,
    verifyHeldVote(run, membership, ingress, vote.message),
    () => {
      pending.votes.set(signerAgentId, { recordHash, ingress });
    },
  ).pipe(Effect.withSpan("acceptSuccessorVote"));
}

/**
 * Hand a member's vote for a successor this endpoint has staged to the
 * protocol phases, which certify it at `q(n)` votes.
 * @param run Recovery run that holds the conversation.
 * @param target The conversation the vote names and the voted record's fold.
 * @param target.conversation The conversation whose head the record extends.
 * @param target.fold The fold of the record the member voted for.
 * @param ingress Verified Router delivery carrying the vote.
 * @param statement The member's durability vote.
 * @returns Whether the vote was taken or ignored.
 */
function acceptStagedSuccessorVote(
  run: SuccessorRun,
  target: Readonly<{
    conversation: EngineConversation;
    fold: EngineActionFold;
  }>,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  statement: Extract<EvidenceStatement, { readonly kind: "durability_vote" }>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  const { conversation, fold } = target;
  const staged =
    fold.certifiedRecord === undefined &&
    extendsHead(conversation, fold.action);
  const { conversationId, signerAgentId } = statement;
  return staged && !fold.durabilityEvidence.has(signerAgentId)
    ? certifyThroughPhases(run, conversationId, [ingress])
    : Effect.succeed(ignoredDisposition);
}

/**
 * Hold a member's verified record or vote toward converting, then convert if
 * the hold is now complete.
 * @param run Recovery run that holds the conversation.
 * @param membership Verified membership of the successor's conversation.
 * @param verified Whether the delivery verified for this conversation.
 * @param hold Records the delivery in the conversation's pending successor.
 * @returns Accepted once held, ignored when the delivery did not verify.
 */
function holdTowardConversion(
  run: SuccessorRun,
  membership: VerifiedMembership,
  verified: Effect.Effect<boolean>,
  hold: () => void,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> {
  return verified.pipe(
    Effect.flatMap((held) => {
      if (!held) {
        return Effect.succeed(ignoredDisposition);
      }
      hold();
      return maybeConvert(run, membership).pipe(Effect.as(acceptedDisposition));
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

/**
 * The run's membership of the conversation an action belongs to, when the
 * action extends that conversation's head.
 * @param run Recovery run that holds the conversation.
 * @param action The action a member's record carries.
 * @returns The membership, or nothing when the action extends no held head.
 */
function membershipExtendedBy(
  run: SuccessorRun,
  action: ActionCore,
): VerifiedMembership | undefined {
  const conversation = run.runtime.conversations.get(action.conversationId);
  return conversation !== undefined && extendsHead(conversation, action)
    ? run.membership(action.conversationId)
    : undefined;
}

function extendsHead(
  conversation: EngineConversation,
  action: ActionCore,
): boolean {
  return (
    action.kind === "POST" &&
    action.previousRecordHash === conversation.head?.recordHash
  );
}

function pendingFor(
  pending: SuccessorRun["pending"],
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
