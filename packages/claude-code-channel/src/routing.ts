/**
 * routing — internal tracker for the `reply` tool's routing decision.
 *
 * OQ5 resolution (spec OQ5 default A): the contract's `reply` tool takes
 * `{text, reply_to?, files?}` with no `chat_id`. MoltZap sessions can span
 * multiple conversations, so the package must resolve which conversation a
 * `reply` call targets:
 *
 *   1. If `reply_to` is provided and resolves to a known `message_id` → its
 *      originating `chat_id`.
 *   2. Else → the chat_id of the most recently observed inbound.
 *   3. Else (no inbound yet) → `ReplyError.NoActiveConversation`.
 *
 * Contract invariant: `reply` always delivers to a real conversation. Never
 * silently drop (spec OQ5).
 *
 * State is internal to one `bootClaudeCodeChannel` boot; no cross-boot
 * persistence, no globals.
 *
 * Map bound: a small ring-buffer cap (implementer picks the size; named in
 * the design doc as "bounded LRU — recent 256 message_ids"). Exceeding the
 * cap evicts the oldest entry; `ReplyToUnknown` fires at the boundary when
 * the caller references a message beyond the window.
 */

import { Data } from "effect";
import type { ConversationId, MessageId } from "./types.js";

class RoutingCapacityInvalid extends Data.TaggedError(
  "RoutingCapacityInvalid",
)<{
  readonly capacity: number;
  readonly message: string;
}> {}

export interface RoutingState {
  /**
   * Record an inbound message. Advances the "last active conversation" pointer and
   * adds the `(message_id, chat_id)` pair to the bounded map.
   */
  readonly recordInbound: (
    messageId: MessageId,
    conversationId: ConversationId,
  ) => void;

  /**
   * Resolve a `reply` call to a target chat_id.
   * - `replyTo` present & known → that message's chat_id.
   * - `replyTo` present & unknown → `{ _tag: "ReplyToUnknown" }`.
   * - `replyTo` absent, last-active present → last-active chat_id.
   * - `replyTo` absent, no inbound yet → `{ _tag: "NoActiveConversation" }`.
   */
  readonly resolveTarget: (replyTo: MessageId | undefined) => RoutingResolution;
}

type RoutingResolution =
  | { readonly _tag: "Resolved"; readonly conversationId: ConversationId }
  | { readonly _tag: "NoActiveConversation" }
  | { readonly _tag: "ReplyToUnknown"; readonly replyTo: MessageId };

const DEFAULT_CAPACITY = 256;

/**
 * Construct a fresh routing state. One instance per boot.
 * @param capacity bounded LRU size (default 256 recent message_ids, per
 * architect design doc §2.4). Exceeding the cap evicts the oldest
 * (FIFO) — relying on JavaScript `Map` preserving insertion order.
 */
export function createRoutingState(
  capacity: number = DEFAULT_CAPACITY,
): RoutingState {
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new RoutingCapacityInvalid({
      capacity,
      message: `createRoutingState: capacity must be a positive finite number, got ${capacity}`,
    });
  }
  const cap = Math.floor(capacity);
  const map = new Map<MessageId, ConversationId>();
  let lastActive: ConversationId | undefined;

  function recordInbound(
    messageId: MessageId,
    conversationId: ConversationId,
  ): void {
    // Refresh the LRU position if present.
    if (map.has(messageId)) {
      map.delete(messageId);
    }
    map.set(messageId, conversationId);
    while (map.size > cap) {
      const oldest = map.keys().next();
      if (oldest.done === true) {
        break;
      }
      map.delete(oldest.value);
    }
    lastActive = conversationId;
  }

  function resolveTarget(replyTo: MessageId | undefined): RoutingResolution {
    if (replyTo !== undefined) {
      const hit = map.get(replyTo);
      if (hit !== undefined) {
        return { _tag: "Resolved", conversationId: hit };
      }
      return { _tag: "ReplyToUnknown", replyTo };
    }
    if (lastActive !== undefined) {
      return { _tag: "Resolved", conversationId: lastActive };
    }
    return { _tag: "NoActiveConversation" };
  }

  return { recordInbound, resolveTarget };
}
