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
 *   3. Else (no inbound yet) → `ReplyError.NoActiveChat`.
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

import type { ChatId, MessageId } from "./types.js";

export interface RoutingState {
  /**
   * Record an inbound message. Advances the "last active chat" pointer and
   * adds the `(message_id, chat_id)` pair to the bounded map.
   */
  readonly recordInbound: (messageId: MessageId, chatId: ChatId) => void;

  /**
   * Resolve a `reply` call to a target chat_id.
   * - `replyTo` present & known → that message's chat_id.
   * - `replyTo` present & unknown → `{ _tag: "ReplyToUnknown" }`.
   * - `replyTo` absent, last-active present → last-active chat_id.
   * - `replyTo` absent, no inbound yet → `{ _tag: "NoActiveChat" }`.
   */
  readonly resolveTarget: (
    replyTo: MessageId | undefined,
  ) => RoutingResolution;
}

export type RoutingResolution =
  | { readonly _tag: "Resolved"; readonly chatId: ChatId }
  | { readonly _tag: "NoActiveChat" }
  | { readonly _tag: "ReplyToUnknown"; readonly replyTo: MessageId };

/**
 * Construct a fresh routing state. One instance per boot.
 *
 * @param capacity bounded LRU size (default chosen by implementer, named
 *        "recent 256 message_ids" in the design doc).
 */
export function createRoutingState(capacity?: number): RoutingState {
  throw new Error("not implemented");
}
