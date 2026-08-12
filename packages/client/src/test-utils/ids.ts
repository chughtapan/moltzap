/**
 * @file Derives stable protocol identifiers from human-readable test labels
 * so fixtures stay deterministic without sharing mutable counters.
 */
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import type { AgentId } from "@moltzap/protocol/identity";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_ALPHABET = "0123456789abcdef";
const HEX_WORD = "00000000";
const UUID_GROUP = "0000";
const FNV_OFFSET_BASIS = Number("0x811c9dc5");
const FNV_PRIME = Number("0x01000193");
const HEX_RADIX = HEX_ALPHABET.length;
const HEX_WORD_WIDTH = HEX_WORD.length;
const UUID_FIRST_END = HEX_WORD.length;
const UUID_SECOND_END = UUID_FIRST_END + UUID_GROUP.length;
const UUID_VERSION_TAIL_START = UUID_SECOND_END + "0".length;
const UUID_VERSION_END = UUID_SECOND_END + UUID_GROUP.length;
const UUID_VARIANT_TAIL_START = UUID_VERSION_END + "0".length;
const UUID_VARIANT_END = UUID_VERSION_END + UUID_GROUP.length;
const UUID_TAIL_END = HEX_WORD.length * UUID_GROUP.length;

/**
 * Derives a stable test agent identifier from a readable fixture label.
 * @param label Fixture-local label or an already valid UUID.
 * @returns A branded agent identifier suitable for protocol fixtures.
 */
export const testAgentId = (label: string): AgentId =>
  agentId(uuidFor("agent", label));

/**
 * Derives a stable test conversation identifier from a readable fixture label.
 * @param label Fixture-local label or an already valid UUID.
 * @returns A branded conversation identifier suitable for protocol fixtures.
 */
export const testConversationId = (label: string): ConversationId =>
  conversationId(uuidFor("conversation", label));

/**
 * Derives a stable test message identifier from a readable fixture label.
 * @param label Fixture-local label or an already valid UUID.
 * @returns A branded message identifier suitable for protocol fixtures.
 */
export const testMessageId = (label: string): MessageId =>
  messageId(uuidFor("message", label));

function uuidFor(namespace: string, label: string): string {
  if (UUID_RE.test(label)) {
    return label;
  }
  const h = hex32(`${namespace}:${label}`);
  return [
    h.slice(0, UUID_FIRST_END),
    h.slice(UUID_FIRST_END, UUID_SECOND_END),
    `4${h.slice(UUID_VERSION_TAIL_START, UUID_VERSION_END)}`,
    `8${h.slice(UUID_VARIANT_TAIL_START, UUID_VARIANT_END)}`,
    h.slice(UUID_VARIANT_END, UUID_TAIL_END),
  ].join("-");
}

function hex32(input: string): string {
  let h1 = FNV_OFFSET_BASIS;
  let h2 = FNV_PRIME;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, FNV_PRIME);
    h2 ^= c + i;
    h2 = Math.imul(h2, FNV_OFFSET_BASIS);
  }
  const parts = [
    h1,
    h2,
    Math.imul(h1 ^ h2, FNV_PRIME),
    Math.imul(h1 + h2, FNV_OFFSET_BASIS),
  ];
  return parts
    .map((p) => (p >>> 0).toString(HEX_RADIX).padStart(HEX_WORD_WIDTH, "0"))
    .join("");
}
