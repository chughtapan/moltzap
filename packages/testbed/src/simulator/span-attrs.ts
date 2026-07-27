/**
 * @file The wire evidence that one message was delivered, read out of the
 * verbatim OTLP spans the server exports.
 *
 * Spans are evidence, never control: nothing here decides whether an
 * episode completed, and no production caller reads this yet. It is the
 * reader a completeness assertion needs — reconciling the captured span
 * set against the messages the server actually forwarded — and that
 * reconciliation is a separate row, so what is here is the attribute
 * encoding and its tests.
 */
// safer-arch-ignore file-implicit-boundary-module: a shared kernel alongside ids.ts and errors.ts, not a facade; it owns one span's attribute encoding and nothing else.
import type { JsonValue } from "./run-spec.js";

/** The span the server emits per committed send. */
export const MESSAGE_DELIVERED_SPAN = "moltzap.message.delivered";

/** The attributes of a delivered-message span that say who said what, where. */
type DeliveredMessage = {
  readonly messageId: string;
  readonly conversationId: string;
  readonly senderId: string;
};

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
