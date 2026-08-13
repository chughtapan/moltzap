/**
 * @file Message payloads, RPCs, callbacks, and notifications.
 */

import { Effect, Schema, type Brand } from "effect";
import { agentId } from "#identity/agents";
import { conversationId, messageId } from "#conversation";
import { ConversationSendAccess } from "#conversation/requirements";
import {
  dateTimeStringSchema,
  defineNotification,
  defineRpc,
  ForbiddenError,
  formatString,
  InvalidParamsError,
  listCursorSchema,
  listLimitSchema,
} from "#transport";
import { AuthenticatedAgent } from "#identity/principals";
import { ActiveAgent } from "#identity/requirements";

const textPartSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32768)),
});

const imagePartSchema = Schema.Struct({
  type: Schema.Literal("image"),
  url: formatString("uri").pipe(Schema.minLength(1)),
  altText: Schema.optional(Schema.String.pipe(Schema.maxLength(256))),
});

const filePartSchema = Schema.Struct({
  type: Schema.Literal("file"),
  url: formatString("uri").pipe(Schema.minLength(1)),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  mimeType: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  ),
  size: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  ),
});

const partSchema = Schema.Union(
  textPartSchema,
  imagePartSchema,
  filePartSchema,
);

/** User-authored message content part. */
export type Part = Schema.Schema.Type<typeof partSchema>;

const messagePartsSchemaValue = Schema.NonEmptyArray(partSchema).pipe(
  Schema.maxItems(10),
);

/**
 * Return the canonical message-parts schema.
 *
 * Recording and other protocol-adjacent boundaries compose this schema
 * directly so persisted bodies cannot drift from the wire contract.
 * @returns The nonempty schema shared by all message boundaries.
 */
export function messagePartsSchema(): typeof messagePartsSchemaValue {
  return messagePartsSchemaValue;
}

/** Nonempty protocol message content. */
export type MessageParts = Schema.Schema.Type<typeof messagePartsSchemaValue>;

const decodeMessagePartsEffect = Schema.decodeUnknown(messagePartsSchemaValue);

/**
 * Decode a message-parts payload and die on malformed persisted data.
 * @param value Value to process.
 * @returns The decoded message parts.
 */
export function decodeMessageParts(
  value: unknown,
): Effect.Effect<MessageParts> {
  return decodeMessagePartsEffect(value, {
    onExcessProperty: "error",
  }).pipe(Effect.orDie);
}

const dateTimeString = dateTimeStringSchema();
const messageParts = messagePartsSchema();

const messageSchema = Schema.Struct({
  id: messageId,
  conversationId: conversationId,
  senderId: agentId,
  parts: messageParts,
  createdAt: dateTimeString,
});

/** Opaque position in a conversation's readable message history. */
export type ConversationCheckpoint = string &
  Brand.Brand<"ConversationCheckpoint">;

/** Validates and decodes opaque conversation checkpoint values. */
export const conversationCheckpoint: Schema.Schema<
  ConversationCheckpoint,
  string
> = Schema.String.pipe(
  Schema.brand("ConversationCheckpoint"),
  Schema.annotations({
    description:
      "Opaque conversation checkpoint. Treat as opaque; do not parse, " +
      "compare, or construct it.",
  }),
);

/** Message row visible to agent callers. */
export type Message = Schema.Schema.Type<typeof messageSchema>;

const messagesSendParams = Schema.Struct({
  conversationId: conversationId,
  parts: messageParts,
});

const messagesSendResult = Schema.Struct({ message: messageSchema });

/**
 * Send a message to a conversation. The server persists the message and
 * broadcasts it to every conversation participant except the sender.
 * @relatedNotification agent/message/received
 */
export const messagesSend = defineRpc({
  name: "agent/message/send",
  params: messagesSendParams,
  result: messagesSendResult,
  requires: [AuthenticatedAgent, ActiveAgent, ConversationSendAccess],
  errors: [],
});

const messagesListParams = Schema.Struct({
  conversationId: conversationId,
  limit: listLimitSchema,
});

const messagesListResult = Schema.Struct({
  messages: Schema.Array(messageSchema),
});

/**
 * List the newest visible messages in a conversation, returned oldest-first.
 * The server enforces conversation participation.
 * @error ForbiddenError when the caller is not a participant of the conversation
 */
export const messagesList = defineRpc({
  name: "agent/message/list",
  params: messagesListParams,
  result: messagesListResult,
  requires: [AuthenticatedAgent, ActiveAgent],
  errors: [ForbiddenError],
});

/**
 * Read a page of visible conversation messages and return the conversation's
 * current opaque checkpoint. The server enforces conversation participation.
 *
 * @error InvalidParamsError when the checkpoint or cursor is invalid
 * @error ForbiddenError when the caller is not a participant of the conversation
 */
export const messagesRead = defineRpc({
  name: "agent/message/read",
  params: Schema.Struct({
    conversationId: conversationId,
    checkpoint: Schema.optional(conversationCheckpoint),
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    messages: Schema.Array(messageSchema),
    checkpoint: conversationCheckpoint,
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AuthenticatedAgent, ActiveAgent],
  errors: [InvalidParamsError, ForbiddenError],
});

/** Agent-callable message RPC catalog. */
export const agentCallableMessageRpcMethods = [
  messagesSend,
  messagesList,
  messagesRead,
] as const;

const messageReceivedNotificationSchema = Schema.Struct({
  message: messageSchema,
});

/** Notification payload for `agent/message/received`. */
export type MessageReceivedNotification = Schema.Schema.Type<
  typeof messageReceivedNotificationSchema
>;

/**
 * Pushed when a new message is delivered to a WebSocket connection.
 * @triggeredBy agent/message/send
 */
export const messageReceivedNotificationDefinition = defineNotification({
  name: "agent/message/received",
  params: messageReceivedNotificationSchema,
});

// safer-arch-ignore no-fat-orchestrator: TRIAGE: This message-domain descriptor catalog owns RPCs, callbacks, and notifications; evaluate splitting those families as the catalog grows.
