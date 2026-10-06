/**
 * @file The evidence certification holds for a position this endpoint does
 * not hold yet: proposals one per author, and durability votes naming a record
 * not staged here. Every bound here is per member, so a faulty member's input
 * takes only its own slot.
 */

import type { AgentId } from "@moltzap/identity";
import { Effect } from "effect";
import type { RouterWorkerIngress } from "../../router/index.js";
import type {
  EngineConversation,
  EngineEarlyVote,
  EngineRuntime,
  EngineWaitingProposal,
} from "../runtime/index.js";
import {
  type ClientRepresentationError,
  type ConversationId,
  type DecodedOuterBody,
  type EvidenceStatement,
  type PostActionCore,
  quorumThreshold,
  type RecordHash,
  verifyOuterMessage,
} from "../../wire/index.js";

/**
 * Whether a POST names a record this endpoint certified before its current
 * head, as a proposal its author sent before seeing the head certified does.
 * @param runtime Engine whose certified folds are checked.
 * @param conversation Conversation the proposal extends.
 * @param action The proposal's action.
 * @returns Whether the action's predecessor is a passed record here.
 */
export function namesPassedRecord(
  runtime: EngineRuntime,
  conversation: EngineConversation,
  action: PostActionCore,
): boolean {
  return (
    action.previousRecordHash !== conversation.head?.recordHash &&
    runtime.recordFolds.get(action.previousRecordHash)?.certifiedRecord !==
      undefined
  );
}

/**
 * Whether `f + 1` members signed a proposal this endpoint holds in a
 * conversation, so the members' position is past this endpoint's head. Until
 * catch-up brings it there, this endpoint neither locks a proposal at its
 * head nor proposes its own posts again: the members already certified a
 * record at that position, and a lock on another action would refuse that
 * record when catch-up brings it.
 * @param runtime Engine whose waiting proposals are checked.
 * @param conversationId Conversation to check.
 * @returns Whether a waiting proposal there has `f + 1` signers.
 */
export function knowsLaterPosition(
  runtime: EngineRuntime,
  conversationId: ConversationId,
): boolean {
  return [
    ...(runtime.waitingProposals.get(conversationId)?.values() ?? []),
  ].some((waiting) => waiting.vouched);
}

/**
 * The signers that show at least one honest member locked a proposal:
 * `f + 1`, or one when `n < 4`, where the guarantee assumes no faulty member.
 * @param waiting The waiting proposal whose conversation sets `n`.
 * @returns How many distinct signers vouch for it.
 */
export function vouchingSigners(waiting: EngineWaitingProposal): number {
  const memberCount = waiting.conversation.membership.members.length;
  return memberCount - quorumThreshold(memberCount) + 1;
}

/**
 * The waiting proposals of one conversation, keyed by author, created empty
 * on first use.
 * @param runtime Engine that holds the proposals.
 * @param conversation Conversation they wait in.
 * @returns The conversation's per-author waiting proposals.
 */
export function heldProposals(
  runtime: EngineRuntime,
  conversation: EngineConversation,
): Map<AgentId, EngineWaitingProposal> {
  const retained = runtime.waitingProposals.get(conversation.conversationId);
  if (retained !== undefined) {
    return retained;
  }
  const created = new Map<AgentId, EngineWaitingProposal>();
  runtime.waitingProposals.set(conversation.conversationId, created);
  return created;
}

/**
 * Keep a durability vote naming a record this endpoint has not staged, once
 * its outer message verifies against that conversation: the latest one per
 * member.
 * @param runtime Engine that may stage the record later.
 * @param ingress Router delivery carrying the vote.
 * @param statement The vote's decoded statement.
 * @returns Completion once the vote is kept or found to name no conversation
 *     here.
 */
export function holdEarlyVote(
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  statement: Extract<EvidenceStatement, { readonly kind: "durability_vote" }>,
): Effect.Effect<void, ClientRepresentationError> {
  const conversation = runtime.conversations.get(statement.conversationId);
  if (conversation?.membership.hash !== statement.membershipHash) {
    return Effect.void;
  }
  return verifyOuterMessage({
    message: ingress.message,
    membership: conversation.membership,
  }).pipe(
    Effect.flatMap(() =>
      Effect.sync(() => {
        const held =
          runtime.earlyVotes.get(conversation.conversationId) ??
          new Map<AgentId, EngineEarlyVote>();
        held.set(ingress.message.senderAgentId, {
          recordHash: statement.recordHash,
          ingress,
        });
        runtime.earlyVotes.set(conversation.conversationId, held);
      }),
    ),
  );
}

/**
 * Remove and return the kept durability votes that name a record this
 * endpoint just staged.
 * @param runtime Engine that staged the record.
 * @param conversationId Conversation of the record.
 * @param recordHash Hash of the staged record.
 * @returns The votes' Router deliveries, to apply as if just arrived.
 */
export function takeEarlyVotes(
  runtime: EngineRuntime,
  conversationId: ConversationId,
  recordHash: RecordHash,
): ReadonlyArray<RouterWorkerIngress<DecodedOuterBody>> {
  const held = runtime.earlyVotes.get(conversationId);
  const matching = [...(held?.entries() ?? [])].filter(
    ([, vote]) => vote.recordHash === recordHash,
  );
  for (const [voter] of matching) {
    held?.delete(voter);
  }
  return matching.map(([, vote]) => vote.ingress);
}
