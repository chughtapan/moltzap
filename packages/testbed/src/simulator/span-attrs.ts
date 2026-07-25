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
  /**
   * Retain a `moltzap.message.delivered` span; any other span is ignored.
   * Reports whether this span was retained, so callers can skip the work
   * that only a new delivered message can change.
   */
  record(
    logicalSequence: LogicalSequence,
    spanName: string,
    raw: JsonValue,
  ): boolean;
  answer(criteria: AnswerCriteria): LogicalSequence | undefined;
};

export function makeDeliveredLog(): DeliveredLog {
  const delivered: Array<DeliveredRecord> = [];
  return {
    record: (logicalSequence, spanName, raw) => {
      if (spanName !== MESSAGE_DELIVERED_SPAN) return false;
      const message = readDeliveredMessage(raw);
      if (message === undefined) return false;
      delivered.push({ logicalSequence, ...message });
      return true;
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
 *
 * The scan starts past the floor: records are appended in the order the
 * single log writer stamped them, so everything before the floor fails
 * the sequence test by construction.
 */
function findAnswer(
  delivered: ReadonlyArray<DeliveredRecord>,
  criteria: AnswerCriteria,
): LogicalSequence | undefined {
  const floorIndex = delivered.findIndex(
    (record) => record.messageId === criteria.afterMessageId,
  );
  const floor = delivered[floorIndex];
  if (floor === undefined) return undefined;
  for (let index = floorIndex + 1; index < delivered.length; index += 1) {
    const record = delivered[index];
    if (record === undefined) continue;
    if (
      record.conversationId === criteria.conversationId &&
      criteria.senders.has(record.senderId) &&
      record.logicalSequence > floor.logicalSequence
    ) {
      return record.logicalSequence;
    }
  }
  return undefined;
}

/**
 * Read the message attributes off a verbatim `moltzap.message.delivered`
 * span. Spans are captured exactly as exported, so the attributes are
 * OTLP's own `[{key, value: {stringValue}}]` encoding rather than a
 * flattened record. A span missing any of the three, or repeating any
 * attribute key, reads as absent — a partial or ambiguous match can never
 * stand in for a delivered message.
 */
export function readDeliveredMessage(
  raw: JsonValue,
): DeliveredMessage | undefined {
  const attributes = otlpStringAttributes(raw);
  if (attributes === undefined) return undefined;
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

/**
 * A repeated key is rejected rather than resolved. OTLP attribute lists
 * are not a map, so a span can carry the same key twice; taking either
 * occurrence would let an appended attribute override the server's own
 * value and redirect a match.
 */
function otlpStringAttributes(
  raw: JsonValue,
): ReadonlyMap<string, string> | undefined {
  const found = new Map<string, string>();
  if (!isRecord(raw)) return found;
  const attributes = raw["attributes"];
  if (!Array.isArray(attributes)) return found;
  for (const attribute of attributes) {
    const entry = readStringAttribute(attribute);
    if (entry === undefined) continue;
    if (found.has(entry.key)) return undefined;
    found.set(entry.key, entry.value);
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
