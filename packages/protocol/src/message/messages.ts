/**
 * @file Message payloads, RPCs, callbacks, and notifications.
 */

import { Schema } from "effect";
import { agentId } from "#identity/agents";
import { conversationId, messageId } from "#conversation";
import { ConversationSendAccess } from "#conversation/requirements";
import { DispatchNotFoundError, leaseId } from "#message/dispatch";
import { defineNotification, defineRpc } from "#transport/descriptor";
import {
  listLimitSchema,
  closedStructGuard,
  errorPayloadFields,
  ForbiddenError,
  dateTimeStringSchema,
} from "#transport";
import { AgentPrincipal } from "#identity/principals";
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

/**
 * The app that authorizes a conversation refused the dispatch. Raised by
 * `agent/message/send` when the app's send hook returns a block verdict (or the
 * fail-closed envelope synthesizes one on timeout, RPC error, or decode
 * failure). The app's reason rides in the `data` arm when present.
 */
export class HookBlockedError extends Schema.TaggedError<HookBlockedError>()(
  "HookBlocked",
  errorPayloadFields,
) {
  static readonly message = "Hook blocked the dispatch";
}

const messageSchema = Schema.Struct({
  id: messageId,
  conversationId: conversationId,
  senderId: agentId,
  parts: messageParts,
  createdAt: dateTimeString,
});

/** Message row visible to agent callers. */
export type Message = Schema.Schema.Type<typeof messageSchema>;

/** Return true when the value is a closed message row. */
export const validateMessage = closedStructGuard(messageSchema);

const dispatchDecisionSchemaValue = Schema.Union(
  Schema.Struct({ tag: Schema.Literal("pending") }),
  Schema.Struct({
    tag: Schema.Literal("forward"),
    recipients: Schema.Array(agentId),
  }),
  Schema.Struct({
    tag: Schema.Literal("block"),
    reason: Schema.optional(Schema.String),
  }),
);

/** Per-message dispatch authorization decision persisted with the message. */
export type DispatchDecision = Schema.Schema.Type<
  typeof dispatchDecisionSchemaValue
>;

/**
 * Return the canonical persisted dispatch-authorization schema.
 * @returns A schema shared by storage and wire validation.
 */
export function dispatchDecisionSchema(): typeof dispatchDecisionSchemaValue {
  return dispatchDecisionSchemaValue;
}

/** Return true when a value is a closed dispatch decision. */
export const validateDispatchDecision = closedStructGuard(
  dispatchDecisionSchemaValue,
);

const messagesSendParams = Schema.Struct({
  conversationId: conversationId,
  parts: messageParts,
  dispatchLeaseId: Schema.optional(leaseId),
});

const messagesSendResult = Schema.Struct({ message: messageSchema });

/**
 * Send a message to a conversation.
 * @error DispatchNotFoundError when the dispatch lease is missing
 * @error ForbiddenError when the sender cannot post or the dispatch lease is consumed/invalid
 * @error HookBlockedError when an app-side send hook blocks the message
 * @relatedNotification agent/message/received
 */
export const messagesSend = defineRpc({
  name: "agent/message/send",
  params: messagesSendParams,
  result: messagesSendResult,
  requires: [AgentPrincipal, ActiveAgent, ConversationSendAccess],
  errors: [HookBlockedError, ForbiddenError, DispatchNotFoundError],
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
  requires: [AgentPrincipal, ActiveAgent],
  errors: [ForbiddenError],
});

/** Agent-callable message RPC catalog. */
export const agentCallableMessageRpcMethods = [
  messagesSend,
  messagesList,
] as const;

const messagesAuthorizeContextSchema = Schema.Struct({
  appId: Schema.String,
  conversationId: conversationId,
  message: Schema.Struct({
    id: messageId,
    senderAgentId: agentId,
    parts: Schema.optional(messageParts),
  }),
  receivedAt: Schema.optional(dateTimeString),
});

const messagesAuthorizeVerdictSchema = Schema.Union(
  Schema.Struct({
    decision: Schema.Literal("Forward"),
    recipients: Schema.Array(agentId),
  }),
  Schema.Struct({
    decision: Schema.Literal("Block"),
    reason: Schema.optional(Schema.String),
  }),
);

/**
 * Server callback asking an app for the per-message fan-out verdict.
 * @error ForbiddenError when the app rejects; the server treats the verdict as a fail-closed block
 */
export const messagesAuthorize = defineRpc({
  name: "app/message/authorize",
  params: messagesAuthorizeContextSchema,
  result: Schema.Struct({ verdict: messagesAuthorizeVerdictSchema }),
  requires: [],
  errors: [ForbiddenError],
});

/** Message callback RPC catalog. */
export const messageCallbackMethods = [messagesAuthorize] as const;

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
