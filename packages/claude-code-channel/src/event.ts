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
import { Either } from "effect";
import type {
  ClaudeChannelNotification,
  ConversationId,
  IsoTimestamp,
  MessageId,
  UserId,
} from "./types.js";
import {
  CLAUDE_CHANNEL_NOTIFICATION_METHOD,
  ConversationId as makeConversationId,
  MessageId as makeMessageId,
  UserId as makeUserId,
} from "./types.js";
import { ContentEmpty, MetaInvalid, type EventShapeError } from "./errors.js";

/** Discriminated result — deliberately narrow, no generic `Result` dep. */
export type EventShapeResult =
  | { readonly _tag: "Ok"; readonly value: ClaudeChannelNotification }
  | { readonly _tag: "Err"; readonly error: EventShapeError };

type BrandResult<T> = Either.Either<T, MetaInvalid>;

const metaInvalid = (reason: string): MetaInvalid =>
  new MetaInvalid({ reason, message: reason });

function unwrapBrand<T>(result: BrandResult<T>, name: string): T {
  return Either.match(result, {
    onLeft: (error) => {
      throw metaInvalid(`${name}: ${error.reason}`);
    },
    onRight: (value) => value,
  });
}

function brandConversationIdSafe(raw: string): BrandResult<ConversationId> {
  if (raw.trim().length === 0) {
    return Either.left(metaInvalid("chat_id must be a non-empty string"));
  }
  try {
    return Either.right(makeConversationId(raw));
  } catch (cause) {
    return Either.left(
      metaInvalid(`chat_id must be a valid conversation id: ${String(cause)}`),
    );
  }
}

function brandMessageIdSafe(raw: string): BrandResult<MessageId> {
  if (raw.trim().length === 0) {
    return Either.left(metaInvalid("message_id must be a non-empty string"));
  }
  try {
    return Either.right(makeMessageId(raw));
  } catch (cause) {
    return Either.left(
      metaInvalid(`message_id must be a valid message id: ${String(cause)}`),
    );
  }
}

function brandUserIdSafe(raw: string): BrandResult<UserId> {
  if (raw.trim().length === 0) {
    return Either.left(metaInvalid("user must be a non-empty string"));
  }
  try {
    return Either.right(makeUserId(raw));
  } catch (cause) {
    return Either.left(
      metaInvalid(`user must be a valid agent id: ${String(cause)}`),
    );
  }
}

// Keep the shape check shallow and let the platform date parser validate the
// actual calendar/time semantics.
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}(?:$|[T ])/u;

function brandIsoTimestampSafe(raw: string): BrandResult<IsoTimestamp> {
  if (raw.trim().length === 0) {
    return Either.left(metaInvalid("ts must be a non-empty string"));
  }
  if (!ISO_DATE_PREFIX.test(raw)) {
    return Either.left(metaInvalid(`ts must be an ISO-8601 timestamp: ${raw}`));
  }
  const parsed = Date.parse(raw.replace(" ", "T"));
  if (Number.isNaN(parsed)) {
    return Either.left(metaInvalid(`ts could not be parsed as a date: ${raw}`));
  }
  return Either.right(raw as IsoTimestamp);
}

/**
 * Narrow a raw string into the branded `ConversationId`. Throws on empty input.
 * For boundary validation, `toClaudeChannelNotification` returns a tagged
 * result; this helper is for callers that have already validated upstream.
 */
export function brandConversationId(raw: string): ConversationId {
  return unwrapBrand(brandConversationIdSafe(raw), "brandConversationId");
}

export function brandMessageId(raw: string): MessageId {
  return unwrapBrand(brandMessageIdSafe(raw), "brandMessageId");
}

export function brandUserId(raw: string): UserId {
  return unwrapBrand(brandUserIdSafe(raw), "brandUserId");
}

export function brandIsoTimestamp(raw: string): IsoTimestamp {
  return unwrapBrand(brandIsoTimestampSafe(raw), "brandIsoTimestamp");
}

interface ClaudeChannelMeta {
  readonly chat_id: ConversationId;
  readonly message_id: MessageId;
  readonly user: UserId;
  readonly ts: IsoTimestamp;
}

function decodeNotificationMeta(
  event: EnrichedInboundMessage,
): Either.Either<ClaudeChannelMeta, EventShapeError> {
  return Either.gen(function* () {
    const senderId =
      event.sender && typeof event.sender.id === "string"
        ? event.sender.id
        : "";
    const chatId = yield* brandConversationIdSafe(event.conversationId);
    const messageId = yield* brandMessageIdSafe(event.id);
    const userId = yield* brandUserIdSafe(senderId);
    const timestamp = yield* brandIsoTimestampSafe(event.createdAt);

    return {
      chat_id: chatId,
      message_id: messageId,
      user: userId,
      ts: timestamp,
    };
  });
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
    return { _tag: "Err", error: new ContentEmpty() };
  }

  return Either.match(decodeNotificationMeta(event), {
    onLeft: (error) => ({ _tag: "Err", error }),
    onRight: (meta) => ({
      _tag: "Ok",
      value: {
        method: CLAUDE_CHANNEL_NOTIFICATION_METHOD,
        params: {
          content,
          meta,
        },
      },
    }),
  });
}
