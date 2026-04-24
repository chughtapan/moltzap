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

type BrandResult<T> =
  | { readonly _tag: "Ok"; readonly value: T }
  | { readonly _tag: "Err"; readonly reason: string };

function brandChatIdSafe(raw: string): BrandResult<ChatId> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { _tag: "Err", reason: "chat_id must be a non-empty string" };
  }
  return { _tag: "Ok", value: raw as ChatId };
}

function brandMessageIdSafe(raw: string): BrandResult<MessageId> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { _tag: "Err", reason: "message_id must be a non-empty string" };
  }
  return { _tag: "Ok", value: raw as MessageId };
}

function brandUserIdSafe(raw: string): BrandResult<UserId> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { _tag: "Err", reason: "user must be a non-empty string" };
  }
  return { _tag: "Ok", value: raw as UserId };
}

// Loose ISO-8601 shape: date-only or date + T + time + optional tz.
const ISO_SHAPE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:?\d{2}|Z)?)?$/;

function brandIsoTimestampSafe(raw: string): BrandResult<IsoTimestamp> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { _tag: "Err", reason: "ts must be a non-empty string" };
  }
  if (!ISO_SHAPE.test(raw)) {
    return { _tag: "Err", reason: `ts must be an ISO-8601 timestamp: ${raw}` };
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return { _tag: "Err", reason: `ts could not be parsed as a date: ${raw}` };
  }
  return { _tag: "Ok", value: raw as IsoTimestamp };
}

/**
 * Narrow a raw string into the branded `ChatId`. Throws on empty input.
 * For boundary validation, `toClaudeChannelNotification` returns a tagged
 * result; this helper is for callers that have already validated upstream.
 */
export function brandChatId(raw: string): ChatId {
  const r = brandChatIdSafe(raw);
  if (r._tag === "Err") {
    throw new Error(`brandChatId: ${r.reason}`);
  }
  return r.value;
}

export function brandMessageId(raw: string): MessageId {
  const r = brandMessageIdSafe(raw);
  if (r._tag === "Err") {
    throw new Error(`brandMessageId: ${r.reason}`);
  }
  return r.value;
}

export function brandUserId(raw: string): UserId {
  const r = brandUserIdSafe(raw);
  if (r._tag === "Err") {
    throw new Error(`brandUserId: ${r.reason}`);
  }
  return r.value;
}

export function brandIsoTimestamp(raw: string): IsoTimestamp {
  const r = brandIsoTimestampSafe(raw);
  if (r._tag === "Err") {
    throw new Error(`brandIsoTimestamp: ${r.reason}`);
  }
  return r.value;
}

/**
 * Convert a `MoltZapChannelCore`-delivered enriched inbound message into the
 * contract-conformant notification payload. Pure function; no I/O.
 */
export function toClaudeChannelNotification(
  event: EnrichedInboundMessage,
): EventShapeResult {
  const content = typeof event.text === "string" ? event.text : "";
  if (content.trim().length === 0) {
    return { _tag: "Err", error: { _tag: "ContentEmpty" } };
  }

  const chatIdR = brandChatIdSafe(event.conversationId);
  if (chatIdR._tag === "Err") {
    return {
      _tag: "Err",
      error: { _tag: "MetaInvalid", reason: chatIdR.reason },
    };
  }
  const messageIdR = brandMessageIdSafe(event.id);
  if (messageIdR._tag === "Err") {
    return {
      _tag: "Err",
      error: { _tag: "MetaInvalid", reason: messageIdR.reason },
    };
  }
  const senderId =
    event.sender && typeof event.sender.id === "string" ? event.sender.id : "";
  const userR = brandUserIdSafe(senderId);
  if (userR._tag === "Err") {
    return {
      _tag: "Err",
      error: { _tag: "MetaInvalid", reason: userR.reason },
    };
  }
  const tsR = brandIsoTimestampSafe(event.createdAt);
  if (tsR._tag === "Err") {
    return {
      _tag: "Err",
      error: { _tag: "MetaInvalid", reason: tsR.reason },
    };
  }

  return {
    _tag: "Ok",
    value: {
      method: "notifications/claude/channel",
      params: {
        content,
        meta: {
          chat_id: chatIdR.value,
          message_id: messageIdR.value,
          user: userR.value,
          ts: tsR.value,
        },
      },
    },
  };
}
