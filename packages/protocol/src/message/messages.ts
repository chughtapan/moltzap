/**
 * @file Message payloads, RPCs, callbacks, and notifications.
 */

import { Schema } from "effect";
import { AgentId } from "#identity/agents";
import {
  ConversationArchivedError,
  ConversationId,
  MessageId,
} from "#conversation";
import {
  ConversationInTask,
  ConversationSendAccess,
} from "#conversation/requirements";
import { TaskReadAccess } from "#task/requirements";
import { DispatchNotFoundError, LeaseId } from "#message/dispatch";
import { HookBlockedError, TaskClosedError, TaskId } from "#task";
import { defineNotification, defineRpc } from "#transport/descriptor";
import {
  ListLimitSchema,
  closedStructGuard,
  errorPayloadFields,
} from "#transport";
import { AgentPrincipal } from "#identity/principals";
import { ActiveAgent } from "#identity/requirements";
import { ForbiddenError } from "#transport";
import { dateTimeStringSchema } from "#transport";
import { messagePartsSchema } from "./parts.js";
export {
  decodeMessageParts,
  decodeMessagePartsText,
  messagePartsSchema,
  validateTextPart,
} from "./parts.js";
export type { MessageParts, Part } from "./parts.js";

const DateTimeString = dateTimeStringSchema();
const MessageParts = messagePartsSchema();

/** The referenced message does not exist, such as a missing reply target. */
export class MessageNotFoundError extends Schema.TaggedError<MessageNotFoundError>()(
  "MessageNotFound",
  errorPayloadFields,
) {
  static readonly message = "Message not found";
}

const MessageSchema = Schema.Struct({
  id: MessageId,
  conversationId: ConversationId,
  senderId: AgentId,
  replyToId: Schema.optional(MessageId),
  parts: MessageParts,
  taggedEntities: Schema.optional(Schema.Array(AgentId)),
  patchedBy: Schema.optional(Schema.String),
  createdAt: DateTimeString,
});

/** Message row visible to agent callers. */
export type Message = Schema.Schema.Type<typeof MessageSchema>;

/** Return true when the value is a closed message row. */
export const validateMessage = closedStructGuard(MessageSchema);

/**
 * Canonical persisted dispatch-authorization contract. Recording evidence
 * composes this schema directly so the two boundaries cannot drift.
 */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- the recording boundary composes this schema directly
export const DispatchDecisionSchema = Schema.Union(
  Schema.Struct({ tag: Schema.Literal("pending") }),
  Schema.Struct({
    tag: Schema.Literal("forward"),
    recipients: Schema.Array(AgentId),
  }),
  Schema.Struct({
    tag: Schema.Literal("block"),
    reason: Schema.optional(Schema.String),
  }),
);

/** Per-message dispatch authorization decision persisted with the message. */
export type DispatchDecision = Schema.Schema.Type<
  typeof DispatchDecisionSchema
>;

/** Return true when a value is a closed dispatch decision. */
export const validateDispatchDecision = closedStructGuard(
  DispatchDecisionSchema,
);

const MessagesSendParams = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
  parts: MessageParts,
  replyToId: Schema.optional(MessageId),
  dispatchLeaseId: Schema.optional(LeaseId),
});

const MessagesSendResult = Schema.Struct({ message: MessageSchema });

/**
 * Send a message to a conversation under a task.
 * @error MessageNotFoundError when the `replyToId` reply target is absent
 * @error DispatchNotFoundError when the dispatch lease is missing
 * @error ForbiddenError when the sender cannot post or the dispatch lease is consumed/invalid
 * @error TaskClosedError when the task is closed or failed
 * @error ConversationArchivedError when the conversation is archived
 * @error HookBlockedError when an app-side send hook blocks the message
 * @relatedNotification agent/message/received
 */
export const MessagesSend = defineRpc({
  name: "agent/message/send",
  params: MessagesSendParams,
  result: MessagesSendResult,
  requires: [
    AgentPrincipal,
    ActiveAgent,
    ConversationInTask,
    ConversationSendAccess,
  ],
  errors: [
    HookBlockedError,
    ForbiddenError,
    MessageNotFoundError,
    DispatchNotFoundError,
    TaskClosedError,
    ConversationArchivedError,
  ],
});

const MessagesListParams = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
  limit: ListLimitSchema,
});

const MessagesListResult = Schema.Struct({
  messages: Schema.Array(MessageSchema),
});

/**
 * List the newest visible messages in a conversation, returned oldest-first.
 * @error ForbiddenError when the caller is not a participant of the conversation
 */
export const MessagesList = defineRpc({
  name: "agent/message/list",
  params: MessagesListParams,
  result: MessagesListResult,
  requires: [AgentPrincipal, ActiveAgent, TaskReadAccess, ConversationInTask],
  errors: [ForbiddenError],
});

/** Agent-callable message RPC catalog. */
export const agentCallableMessageRpcMethods = [
  MessagesSend,
  MessagesList,
] as const;

const MessagesAuthorizeContextSchema = Schema.Struct({
  taskId: TaskId,
  appId: Schema.String,
  conversationId: ConversationId,
  message: Schema.Struct({
    id: MessageId,
    senderAgentId: AgentId,
    parts: Schema.optional(MessageParts),
  }),
  receivedAt: Schema.optional(DateTimeString),
});

const MessagesAuthorizeVerdictSchema = Schema.Union(
  Schema.Struct({
    decision: Schema.Literal("Forward"),
    recipients: Schema.Array(AgentId),
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
export const MessagesAuthorize = defineRpc({
  name: "app/message/authorize",
  params: MessagesAuthorizeContextSchema,
  result: Schema.Struct({ verdict: MessagesAuthorizeVerdictSchema }),
  requires: [],
  errors: [ForbiddenError],
});

/** Message callback RPC catalog. */
export const messageCallbackMethods = [MessagesAuthorize] as const;

const MessageReceivedNotificationSchema = Schema.Struct({
  taskId: TaskId,
  message: MessageSchema,
});

/** Notification payload for `agent/message/received`. */
export type MessageReceivedNotification = Schema.Schema.Type<
  typeof MessageReceivedNotificationSchema
>;

/**
 * Pushed when a new message is delivered to a WebSocket connection.
 * @triggeredBy agent/message/send
 */
export const MessageReceivedNotificationDefinition = defineNotification({
  name: "agent/message/received",
  params: MessageReceivedNotificationSchema,
});

/** Message notification catalog. */
export const messageNotifications = [
  MessageReceivedNotificationDefinition,
] as const;

// safer-arch-ignore no-fat-orchestrator: TRIAGE: This message-domain descriptor catalog owns RPCs, callbacks, and notifications; evaluate splitting those families as the catalog grows.
