/**
 * @file The messages one episode observed in band, and the rule that
 * decides whether one of them answers another.
 *
 * Two consumers turn a verdict on it: the `awaitReplyFrom` step gate and
 * the done-signal predicates. They differ in consequence, not in
 * evidence, so the record and the match rule live here once.
 *
 * This module is a leaf on purpose. `run-spec.ts` imports `drivers.ts` as
 * a value to resolve driver names at materialization, so a value edge
 * from `drivers.ts` back into `event-log.ts` would close
 * `drivers -> event-log -> run-spec -> drivers`. That cycle breaks Effect
 * Schema class initialization at module-eval time: one side observes an
 * undefined schema and the failure lands at import, not at a call site.
 * Cohesion would put this in `event-log.ts`. Do not move it there.
 */
// safer-arch-ignore file-implicit-boundary-module: a shared kernel alongside ids.ts and errors.ts, not a facade; its two consumers are the gate and the done-signal that read the same evidence, and the import cycle documented above is what forbids folding it into the module that owns event shape.
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import type { AgentId } from "@moltzap/protocol/identity";
import type { Message } from "@moltzap/protocol/message";
import type { LogicalSequence } from "./ids.js";

/**
 * A message as the run observes it: from its own `MessagesSend` result,
 * or from an `agent/message/received` notification. `createdAt` is the
 * server's own assignment and is the only ordering the answer rule
 * trusts; it is millisecond-resolution, so it is a partial order and
 * `AnswerOutcome` carries the tie. `replyToId` is recorded, never
 * depended on: the field is on every wire message, and whether an agent
 * harness populates it is a property of the harness.
 */
export type ObservedMessage = {
  readonly messageId: MessageId;
  readonly conversationId: ConversationId;
  readonly senderId: AgentId;
  readonly replyToId: MessageId | undefined;
  /** Server-assigned commit time, ISO-8601. Millisecond resolution. */
  readonly createdAt: string;
};

/**
 * Project a wire `Message` into the log's record. The rename is the
 * point: the protocol calls it `id`, and every other id in this module is
 * qualified, so an unqualified `id` alongside `conversationId` and
 * `senderId` reads as ambiguous at every call site.
 */
export function observedFrom(message: Message): ObservedMessage {
  return {
    messageId: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    replyToId: message.replyToId,
    createdAt: message.createdAt,
  };
}

/**
 * Project a `wire.message` event's own fields into the log's record. The
 * parameter is structural rather than the event class, which is what
 * keeps this module a leaf: the episode records what it drained and a
 * test records the same shape through the same projection, so neither can
 * drift from the other.
 */
export function observedFromEvent(event: {
  readonly messageId: MessageId;
  readonly conversationId: ConversationId;
  readonly senderId: AgentId;
  readonly replyToId?: MessageId | undefined;
  readonly createdAt: string;
}): ObservedMessage {
  return {
    messageId: event.messageId,
    conversationId: event.conversationId,
    senderId: event.senderId,
    replyToId: event.replyToId,
    createdAt: event.createdAt,
  };
}

/**
 * How the run learned of a message, and — for a received one — the
 * observing event that carried it. The two travel together because they
 * are one fact: the run's own sends have no event of their own, and every
 * received message arrives as one. Splitting them into a tag and an
 * optional position would admit two states the domain does not have and
 * force every reader to re-check for them.
 */
type Observation =
  | { readonly origin: "sent" }
  | { readonly origin: "received"; readonly at: LogicalSequence };

/**
 * What counts as an answer: a sender in `senders`, in this conversation,
 * committed by the server after the awaited message.
 */
export type AnswerCriteria = {
  readonly conversationId: ConversationId;
  readonly afterMessageId: MessageId;
  readonly senders: ReadonlySet<AgentId>;
};

/**
 * Every outcome the answer rule can reach.
 *
 * `no-floor` is the missing-floor shape made expressible. The floor is
 * written synchronously from the send's own result, so on the live path
 * it is unreachable; the branch exists so that if it is ever reached the
 * episode fails with the awaited id instead of returning "not yet" for
 * the rest of the run.
 *
 * `ambiguous` is the honest residue of ordering by a millisecond
 * timestamp assigned in application code: two messages sharing a
 * `createdAt`, or a clock that moved backwards, cannot be ordered by it.
 * It resolves as not-yet-answered, so a tie waits rather than guessing.
 */
export type AnswerOutcome =
  | {
      readonly _tag: "answered";
      readonly at: LogicalSequence;
      readonly message: ObservedMessage;
    }
  | { readonly _tag: "unanswered" }
  | { readonly _tag: "ambiguous"; readonly tiedWith: MessageId }
  | { readonly _tag: "no-floor"; readonly awaited: MessageId };

/**
 * Every message this episode has observed. Retention removes the arming
 * race: a consumer can ask about a conversation it learns of later and
 * still match a message recorded before the question.
 */
export type MessageLog = {
  /**
   * Retain one observed message. Reports whether the record is new; a
   * repeated message id collapses, so reconnect backfill re-delivering
   * history cannot double-count.
   */
  record(observation: Observation, message: ObservedMessage): boolean;
  answer(criteria: AnswerCriteria): AnswerOutcome;
  /** Messages observed from one sender; idempotent under redelivery. */
  countFrom(senderId: AgentId): number;
};

type ObservedRecord = Observation & { readonly message: ObservedMessage };

export function makeMessageLog(): MessageLog {
  const records: Array<ObservedRecord> = [];
  const byMessageId = new Map<MessageId, ObservedRecord>();
  const countBySender = new Map<AgentId, number>();
  return {
    record: (observation, message) => {
      if (byMessageId.has(message.messageId)) return false;
      const record: ObservedRecord = { ...observation, message };
      records.push(record);
      byMessageId.set(message.messageId, record);
      countBySender.set(
        message.senderId,
        (countBySender.get(message.senderId) ?? 0) + 1,
      );
      return true;
    },
    answer: (criteria) => findAnswer(records, byMessageId, criteria),
    countFrom: (senderId) => countBySender.get(senderId) ?? 0,
  };
}

/**
 * The first received message in the criteria's conversation, from an
 * accepted sender, committed after the awaited one.
 *
 * Ordering is the server's `createdAt` and never observation position:
 * the server schedules its notification writes before the sender's own
 * send returns, so one queue's arrival order says nothing about which
 * message the server committed first. `createdAt` is the same fact for
 * both messages however they were observed.
 *
 * It is a partial order. `createdAt` is stamped in application code at
 * millisecond resolution, so two commits inside one millisecond compare
 * equal; that is `ambiguous`, and it waits rather than guessing. A
 * candidate strictly after the floor always wins over a tie.
 */
function findAnswer(
  records: ReadonlyArray<ObservedRecord>,
  byMessageId: ReadonlyMap<MessageId, ObservedRecord>,
  criteria: AnswerCriteria,
): AnswerOutcome {
  const floor = byMessageId.get(criteria.afterMessageId);
  if (floor === undefined) {
    return { _tag: "no-floor", awaited: criteria.afterMessageId };
  }
  const floorAt = floor.message.createdAt;
  let tied: ObservedRecord | undefined;
  for (const record of candidatesOf(records, criteria)) {
    if (record.message.createdAt > floorAt) {
      return { _tag: "answered", at: record.at, message: record.message };
    }
    if (record.message.createdAt === floorAt) tied ??= record;
  }
  return tied === undefined
    ? { _tag: "unanswered" }
    : { _tag: "ambiguous", tiedWith: tied.message.messageId };
}

/**
 * The records that could answer, in observation order: a received message
 * in the awaited conversation, from a sender the criteria accept. The
 * run's own sends are the questions, never answers, and only a received
 * record carries the position a firing can cite.
 */
function candidatesOf(
  records: ReadonlyArray<ObservedRecord>,
  criteria: AnswerCriteria,
): ReadonlyArray<Extract<ObservedRecord, { origin: "received" }>> {
  return records.flatMap((record) =>
    record.origin === "received" &&
    record.message.conversationId === criteria.conversationId &&
    criteria.senders.has(record.message.senderId)
      ? [record]
      : [],
  );
}
