/**
 * @file Message payloads, RPCs, callbacks, and notifications.
 */

import { Schema, type Brand } from "effect";
import { agentId } from "#identity/agents";
import { conversationId, messageId } from "#conversation";
import { ConversationSendAccess } from "#conversation/requirements";
import { defineNotification, defineRpc } from "#transport/descriptor";
import {
  listLimitSchema,
  listCursorSchema,
  closedStructGuard,
  ForbiddenError,
  InvalidParamsError,
  dateTimeStringSchema,
} from "#transport";
import { AuthenticatedAgent } from "#identity/principals";
import { ActiveAgent } from "#identity/requirements";
import { messagePartsSchema } from "./parts.js";
/** Re-exports the public API from `./parts.js`. */
export {
  decodeMessageParts,
  decodeMessagePartsText,
  messagePartsSchema,
  validateTextPart,
} from "./parts.js";
/** Re-exports the public API from `./parts.js`. */
export type { MessageParts, Part } from "./parts.js";

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

/** Return true when the value is a closed message row. */
export const validateMessage = closedStructGuard(messageSchema);

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

/** Message notification catalog. */
export const messageNotifications = [
  messageReceivedNotificationDefinition,
] as const;

// safer-arch-ignore no-fat-orchestrator: TRIAGE: This message-domain descriptor catalog owns RPCs, callbacks, and notifications; evaluate splitting those families as the catalog grows.
