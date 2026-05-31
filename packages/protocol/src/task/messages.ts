import { Schema } from "effect";
import {
  brandedId,
  dateTimeStringSchema,
  formatString,
  closedStructGuard,
} from "../schema-primitives.js";
import { ListLimitSchema } from "../pagination.js";
import { AgentId } from "../identity/agents.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import { ConversationId, MessageId } from "./conversations.js";
import { TaskId } from "./ids.js";

export const LeaseId = brandedId("LeaseId");
export type LeaseId = Schema.Schema.Type<typeof LeaseId>;

// #705 HALF-2 — `messages/send` + `messages/list` are agent-originated; their
// per-frame capabilities (`ConversationInTask`, `MessageSendPermission`,
// `TaskReadAccess`) are now declared at the server binding site as
// `CapabilityMiddleware` tuples and read the caller via `CurrentPrincipal`,
// NOT as descriptor `capabilities` + `argsOf` resolvers. The wire descriptor
// here carries only the params/result shape.

const DateTimeString = dateTimeStringSchema();

const TextPartSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32768)),
});

const ImagePartSchema = Schema.Struct({
  type: Schema.Literal("image"),
  url: formatString("uri").pipe(Schema.minLength(1)),
  altText: Schema.optional(Schema.String.pipe(Schema.maxLength(256))),
});

const FilePartSchema = Schema.Struct({
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

const PartSchema = Schema.Union(
  TextPartSchema,
  ImagePartSchema,
  FilePartSchema,
);

export type Part = Schema.Schema.Type<typeof PartSchema>;

const MessagePartsSchema = Schema.Array(PartSchema).pipe(
  Schema.minItems(1),
  Schema.maxItems(10),
);

const MessageSchema = Schema.Struct({
  id: MessageId,
  conversationId: ConversationId,
  senderId: AgentId,
  replyToId: Schema.optional(MessageId),
  parts: MessagePartsSchema,
  taggedEntities: Schema.optional(Schema.Array(AgentId)),
  patchedBy: Schema.optional(Schema.String),
  createdAt: DateTimeString,
});

export type Message = Schema.Schema.Type<typeof MessageSchema>;

export const validateTextPart = closedStructGuard(TextPartSchema);
export const validateMessage = closedStructGuard(MessageSchema);

export function messagePartsSchema(): typeof MessagePartsSchema {
  return MessagePartsSchema;
}

// ── dispatch_decision ───────────────────────────────────────────────
//
// Per-message dispatch-authorization verdict resolved by the
// `messages/authorize` round-trip. Lives on the `messages.dispatch_decision`
// jsonb column server-side. Wire exposure is app-caller-only:
//
// - `MessageSchema` (above) stays the canonical shape for non-app
//   callers — sender, recipient, any other agent. It does NOT carry
//   `dispatch_decision`. Recipients see only `forward` rows where they
//   appear in `recipients` (filter applied server-side); they have
//   no need to inspect the verdict.
// - `MessageWithDispatchDecisionSchema` (below) extends `MessageSchema`
//   with the verdict. The app caller for a task sees this shape.
//
// Two-schema (this file) is chosen over runtime-strip (single optional
// field) to keep TS strict at non-app read sites: non-app consumers
// literally cannot reference `dispatchDecision` because the field is
// not in their type.

const DispatchDecisionSchema = Schema.Union(
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

export type DispatchDecision = Schema.Schema.Type<
  typeof DispatchDecisionSchema
>;
// Strict, excess-rejecting guard over the verdict union. Keeps the
// boolean-guard call shape the live cross-package consumer
// `server/.../message.service.ts → validateDispatchDecision(raw)` relies
// on, rejecting excess properties at the trust boundary.
export const validateDispatchDecision = closedStructGuard(
  DispatchDecisionSchema,
);

const MessageWithDispatchDecisionSchema = Schema.extend(
  MessageSchema,
  Schema.Struct({ dispatchDecision: DispatchDecisionSchema }),
);

export type MessageWithDispatchDecision = Schema.Schema.Type<
  typeof MessageWithDispatchDecisionSchema
>;

export function dispatchDecisionSchema(): typeof DispatchDecisionSchema {
  return DispatchDecisionSchema;
}

export function messageWithDispatchDecisionSchema(): typeof MessageWithDispatchDecisionSchema {
  return MessageWithDispatchDecisionSchema;
}

/**
 * Send a message to a conversation under a task. Both `taskId` and
 * `conversationId` are required; the conversation must already exist
 * (created via `task/conversation/create`) and the sender must be a
 * participant.
 * @returns The created message with ID, sequence number, and timestamp.
 * @error NotFoundError when Conversation not found
 * @error ForbiddenError when Not a participant in the conversation
 * @error RateLimitedError when Message rate limit exceeded
 * @relatedNotification messages/received
 */
export const MessagesSend = defineRpc({
  name: "messages/send",
  params: Schema.Struct({
    taskId: TaskId,
    conversationId: ConversationId,
    parts: MessagePartsSchema,
    replyToId: Schema.optional(MessageId),
    dispatchLeaseId: Schema.optional(LeaseId),
  }),
  result: Schema.Struct({ message: MessageSchema }),
});

/**
 * List messages in a conversation with cursor-based pagination using sequence numbers.
 * @error NotFoundError when Conversation not found
 * @error ForbiddenError when Not a participant
 */
export const MessagesList = defineRpc({
  name: "messages/list",
  params: Schema.Struct({
    taskId: TaskId,
    conversationId: ConversationId,
    sinceSeq: Schema.optional(
      Schema.String.annotations({
        description: "Snowflake seq cursor (string-encoded BIGINT)",
      }),
    ),
    limit: ListLimitSchema,
  }),
  result: Schema.Struct({
    messages: Schema.Array(MessageSchema),
    hasMore: Schema.Boolean,
  }),
});

const MessageReceivedNotificationSchema = Schema.Struct({
  taskId: TaskId,
  message: MessageSchema,
});

export type MessageReceivedNotification = Schema.Schema.Type<
  typeof MessageReceivedNotificationSchema
>;

/**
 * Pushed when a new message is delivered to your WebSocket connection.
 * @triggeredBy messages/send
 */
export const MessageReceivedNotificationDefinition = defineNotification({
  name: "messages/received",
  params: MessageReceivedNotificationSchema,
});
