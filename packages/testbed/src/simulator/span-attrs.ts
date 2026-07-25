/**
 * @file The wire evidence that one message was delivered, read out of the
 * verbatim OTLP spans the server exports.
 *
 * Two consumers need this as a value: the episode's `awaitReplyFrom` gate
 * and the `last-step-answered` done-signal. They differ in consequence,
 * not in evidence, so the reader and the match rule live here once.
 *
 * This module is a leaf on purpose. `run-spec.ts` imports `drivers.ts` as
 * a value to resolve driver names at materialization, so a value edge
 * from `drivers.ts` back into `event-log.ts` would close
 * `drivers -> event-log -> run-spec -> drivers`. That cycle breaks Effect
 * Schema class initialization at module-eval time: one side observes an
 * undefined schema and the failure lands at import, not at a call site.
 * Cohesion would put this in `event-log.ts`. Do not move it there.
 */
// safer-arch-ignore file-implicit-boundary-module: a shared kernel alongside ids.ts and errors.ts, not a facade; its two consumers are the gate and the done-signal that read the same evidence, and the import cycle documented above is what forbids folding it into the module that owns span shape.
import type { LogicalSequence } from "./ids.js";
import type { JsonValue } from "./run-spec.js";

/** The span the server emits per committed send. */
export const MESSAGE_DELIVERED_SPAN = "moltzap.message.delivered";

/** The attributes of a delivered-message span that say who said what, where. */
type DeliveredMessage = {
  readonly messageId: string;
  readonly conversationId: string;
  readonly senderId: string;
};

/** A delivered message at its position in the log's total order. */
type DeliveredRecord = DeliveredMessage & {
  readonly logicalSequence: LogicalSequence;
};

/** What counts as an answer: a sender in `senders`, in this conversation, after this message. */
export type AnswerCriteria = {
  readonly conversationId: string;
  /** The message whose own delivered span sets the floor an answer must clear. */
  readonly afterMessageId: string;
  readonly senders: ReadonlySet<string>;
};

/**
 * Every delivered-message span the episode has seen, and the first answer
 * to a given message within it.
 *
 * Retention is what removes the arming race. A consumer can ask about a
 * conversation it only learns of later and still match a span that
 * arrived before the question, so nothing has to be armed ahead of the
 * speech it is waiting on.
 */
export type DeliveredLog = {
  /** Retain a `moltzap.message.delivered` span; any other span is ignored. */
  record(
    logicalSequence: LogicalSequence,
    spanName: string,
    raw: JsonValue,
  ): void;
  answer(criteria: AnswerCriteria): LogicalSequence | undefined;
};

export function makeDeliveredLog(): DeliveredLog {
  const delivered: Array<DeliveredRecord> = [];
  return {
    record: (logicalSequence, spanName, raw) => {
      if (spanName !== MESSAGE_DELIVERED_SPAN) return;
      const message = readDeliveredMessage(raw);
      if (message !== undefined) {
        delivered.push({ logicalSequence, ...message });
      }
    },
    answer: (criteria) => findAnswer(delivered, criteria),
  };
}

/**
 * The first delivered span in the criteria's conversation, from an
 * accepted sender, ordered after the span carrying the awaited message.
 * Ordering is the log's total order, so the comparison holds however the
 * exporter batched the two spans. Until the awaited message's own span
 * arrives there is no floor, and therefore no answer.
 */
function findAnswer(
  delivered: ReadonlyArray<DeliveredRecord>,
  criteria: AnswerCriteria,
): LogicalSequence | undefined {
  const floor = delivered.find(
    (record) => record.messageId === criteria.afterMessageId,
  );
  if (floor === undefined) return undefined;
  return delivered.find(
    (record) =>
      record.conversationId === criteria.conversationId &&
      criteria.senders.has(record.senderId) &&
      record.logicalSequence > floor.logicalSequence,
  )?.logicalSequence;
}

/**
 * Read the message attributes off a verbatim `moltzap.message.delivered`
 * span. Spans are captured exactly as exported, so the attributes are
 * OTLP's own `[{key, value: {stringValue}}]` encoding rather than a
 * flattened record. A span missing any of the three reads as absent, so a
 * partial match can never stand in for a delivered message.
 */
export function readDeliveredMessage(
  raw: JsonValue,
): DeliveredMessage | undefined {
  const attributes = otlpStringAttributes(raw);
  const messageId = attributes.get("moltzap.message.id");
  const conversationId = attributes.get("moltzap.message.conversation_id");
  const senderId = attributes.get("moltzap.message.sender_id");
  if (
    messageId === undefined ||
    conversationId === undefined ||
    senderId === undefined
  ) {
    return undefined;
  }
  return { messageId, conversationId, senderId };
}

function otlpStringAttributes(raw: JsonValue): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  if (!isRecord(raw)) return found;
  const attributes = raw["attributes"];
  if (!Array.isArray(attributes)) return found;
  for (const attribute of attributes) {
    const entry = readStringAttribute(attribute);
    if (entry !== undefined) found.set(entry.key, entry.value);
  }
  return found;
}

function readStringAttribute(
  attribute: JsonValue,
): { readonly key: string; readonly value: string } | undefined {
  if (!isRecord(attribute)) return undefined;
  const key = attribute["key"];
  const wrapper = attribute["value"];
  if (typeof key !== "string") return undefined;
  if (wrapper === undefined || !isRecord(wrapper)) return undefined;
  const value = wrapper["stringValue"];
  return typeof value === "string" ? { key, value } : undefined;
}

function isRecord(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
