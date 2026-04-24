/**
 * event — MoltZap inbound → Claude Code channel notification translator.
 *
 * Transplanted from zapbot `src/claude-channel/event.ts` (verdict §(b) MOVE
 * row 1). Adapted:
 *   - Drops `MoltzapInbound` branded IDs; consumes `EnrichedInboundMessage`
 *     from `@moltzap/client`.
 *   - Corrects meta-key divergence from zapbot's invented names to the
 *     official channel contract names (spec Goal 4, A5).
 *
 * Meta-key mapping (from `EnrichedInboundMessage` to contract meta shape):
 *
 *   EnrichedInboundMessage.conversationId   → meta.chat_id
 *   EnrichedInboundMessage.sender.id        → meta.user
 *   EnrichedInboundMessage.id               → meta.message_id
 *   EnrichedInboundMessage.createdAt (ISO)  → meta.ts
 *
 * Reference: fakechat/server.ts:135-148 (contract meta shape).
 *
 * Stubs only. Bodies fill in implement-staff.
 */

import type { EnrichedInboundMessage } from "@moltzap/client";
import type {
  ClaudeChannelNotification,
  ChatId,
  IsoTimestamp,
  MessageId,
  UserId,
} from "./types.js";
import type { EventShapeError } from "./errors.js";

/** Discriminated result — deliberately narrow, no generic `Result` dep. */
export type EventShapeResult =
  | { readonly _tag: "Ok"; readonly value: ClaudeChannelNotification }
  | { readonly _tag: "Err"; readonly error: EventShapeError };

/**
 * Convert a `MoltZapChannelCore`-delivered enriched inbound message into the
 * contract-conformant notification payload. Pure function; no I/O.
 */
export function toClaudeChannelNotification(
  event: EnrichedInboundMessage,
): EventShapeResult {
  throw new Error("not implemented");
}

/**
 * Narrow a raw string into the branded `ChatId`. Runs at the mapping
 * boundary so the rest of the module can trust the type.
 */
export function brandChatId(raw: string): ChatId {
  throw new Error("not implemented");
}

/** Narrow a raw string into the branded `MessageId`. */
export function brandMessageId(raw: string): MessageId {
  throw new Error("not implemented");
}

/** Narrow a raw string into the branded `UserId`. */
export function brandUserId(raw: string): UserId {
  throw new Error("not implemented");
}

/** Narrow a raw ISO-8601 string into the branded `IsoTimestamp`. */
export function brandIsoTimestamp(raw: string): IsoTimestamp {
  throw new Error("not implemented");
}
