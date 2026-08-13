/**
 * @file Message payloads, RPCs, callbacks, and notifications.
 */

import { Schema } from "effect";
import { agentId } from "#identity/agents";
import { conversationId, messageId } from "#conversation";
import { ConversationSendAccess } from "#conversation/requirements";
import {
  dateTimeStringSchema,
  defineNotification,
  defineRpc,
  formatString,
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

const dateTimeString = dateTimeStringSchema();
const messageParts = messagePartsSchema();

const messageSchema = Schema.Struct({
  id: messageId,
  conversationId: conversationId,
  senderId: agentId,
  parts: messageParts,
  createdAt: dateTimeString,
});

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

/** Agent-callable message RPC catalog. */
export const agentCallableMessageRpcMethods = [messagesSend] as const;

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
