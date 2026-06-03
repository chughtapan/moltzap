import { Either, Schema } from "effect";
import {
  brandedId,
  dateTimeStringSchema,
  formatString,
} from "../schema-primitives.js";
import { ListLimitSchema } from "../pagination.js";
import { AgentId } from "../identity/agents.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import { AgentPrincipal, AgentClaimed } from "../transport/principal.js";
import { ConversationId, MessageId } from "./conversations.js";
import { HookBlockedError, TaskClosedError } from "./tasks.js";
import { ConversationArchivedError } from "./conversations.js";
import { ForbiddenError } from "../transport/wire-errors.js";
import { TaskId } from "./ids.js";
import {
  ConversationInTask,
  ConversationSendAccess,
  TaskReadAccess,
} from "./capabilities/index.js";

// ═══════════════════════════════════════════════════════════════════
// SHARED — message value types used by 2+ blocks in this file.
//
// `MessageSchema` is the canonical message-row shape returned by BOTH
// `messages/send` (single) and `messages/list` (array), pushed by the
// `messages/received` notification, and extended by the app-caller
// `dispatch_decision` shape below. Its part schemas are the wire shape
// `messages/send` accepts on the way in, so they live here, not in the
// send block. Everything else is method-local and lives in its own
// contiguous block below.
// ═══════════════════════════════════════════════════════════════════

const DateTimeString = dateTimeStringSchema();

/** Optional supplemental wire fields every domain tagged-error carries. */
const errorPayloadFields = {
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
} as const;

/** The referenced message does not exist (e.g. a `replyToId` reply target). */
export class MessageNotFoundError extends Schema.TaggedError<MessageNotFoundError>()(
  "MessageNotFound",
  errorPayloadFields,
) {
  static readonly message = "Message not found";
}

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

/**
 * Boolean type-guard that REJECTS excess keys. A bare `Schema.is` accepts
 * extra keys (Effect strips them by default); these are domain trust
 * boundaries (DB-read parts/messages, app-supplied verdicts) where an extra
 * key signals a malformed value and must fail, so the guard decodes with
 * `{ onExcessProperty: "error" }`.
 */
const closedGuard =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (value: unknown): value is A =>
    Either.match(
      Schema.decodeUnknownEither(schema)(value, { onExcessProperty: "error" }),
      { onLeft: () => false, onRight: () => true },
    );

export const validateTextPart = closedGuard(TextPartSchema);
export const validateMessage = closedGuard(MessageSchema);

export function messagePartsSchema(): typeof MessagePartsSchema {
  return MessagePartsSchema;
}

// ═══════════════════════════════════════════════════════════════════
// messages/send
// ═══════════════════════════════════════════════════════════════════

export const LeaseId = brandedId("LeaseId");
export type LeaseId = Schema.Schema.Type<typeof LeaseId>;

/**
 * The referenced dispatch lease does not exist (or the caller is not its
 * moderator). Lives here next to {@link LeaseId} — the lease-id vocabulary the
 * `messages/send` `dispatchLeaseId` and the app-layer `dispatches/get` both
 * key on — so both layers raise the same typed not-found without a
 * `task → app` import cycle.
 */
export class DispatchNotFoundError extends Schema.TaggedError<DispatchNotFoundError>()(
  "DispatchNotFound",
  errorPayloadFields,
) {
  static readonly message = "Dispatch lease not found";
}

const MessagesSendParams = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
  parts: MessagePartsSchema,
  replyToId: Schema.optional(MessageId),
  dispatchLeaseId: Schema.optional(LeaseId),
});

const MessagesSendResult = Schema.Struct({ message: MessageSchema });

/**
 * Send a message to a conversation under a task. Both `taskId` and
 * `conversationId` are required; the conversation must already exist
 * (created via `task/conversation/create`) and the sender must be a
 * participant.
 *
 * - **Principal:** `AgentPrincipal` head + `AgentClaimed` (claimed/active agent).
 * - **Params:** `taskId`, `conversationId`, `parts` (1–10 text/image/file
 *   parts), optional `replyToId`, optional `dispatchLeaseId`.
 * - **Result:** the created `message` (ID, parts, sender, timestamp).
 * - **Caps (run order):** `ConversationInTask` resolves the conversation's
 *   task membership; `ConversationSendAccess` proves participation and does
 *   the ONE joined (`conversations ⋈ tasks`) read, handing the send row to
 *   the handler. The remaining send preconditions — task-active,
 *   conversation-not-archived, reply-target — are handler-body guards that
 *   refine that provided row (they share the one read; `@effect/rpc`
 *   middlewares cannot read each other's provided value, so a refinement
 *   that depends on the row is a handler guard, not a standalone middleware).
 * @returns The created message with ID, sequence number, and timestamp.
 * @error MessageNotFoundError when the `replyToId` reply target is absent
 * @error DispatchNotFoundError when the dispatch lease is missing
 * @error ForbiddenError when Not a participant, or the dispatch lease is consumed/invalid (`data.reason: "LeaseInvalid"`)
 * @error TaskClosedError when the task is no longer active
 * @error ConversationArchivedError when the conversation is archived
 * @error HookBlockedError when an app-side send hook blocks the message
 * @relatedNotification messages/received
 */
export const MessagesSend = defineRpc({
  name: "messages/send",
  params: MessagesSendParams,
  result: MessagesSendResult,
  requires: [
    AgentPrincipal,
    AgentClaimed,
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

// ═══════════════════════════════════════════════════════════════════
// messages/list
// ═══════════════════════════════════════════════════════════════════

const MessagesListParams = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
  sinceSeq: Schema.optional(
    Schema.String.annotations({
      description: "Snowflake seq cursor (string-encoded BIGINT)",
    }),
  ),
  limit: ListLimitSchema,
});

const MessagesListResult = Schema.Struct({
  messages: Schema.Array(MessageSchema),
  hasMore: Schema.Boolean,
});

/**
 * List messages in a conversation with cursor-based pagination using sequence
 * numbers.
 *
 * - **Principal:** `AgentPrincipal` head + `AgentClaimed` (claimed/active agent).
 * - **Params:** `taskId`, `conversationId`, optional `sinceSeq` cursor, `limit`.
 * - **Result:** the `messages` page plus `hasMore`.
 * - **Caps (run order):** `TaskReadAccess` proves the caller may read the task,
 *   then `ConversationInTask` resolves the conversation's task membership.
 *   Conversation-not-found rides those cap error channels.
 * @error ForbiddenError when the caller is not a participant of the conversation
 */
export const MessagesList = defineRpc({
  name: "messages/list",
  params: MessagesListParams,
  result: MessagesListResult,
  requires: [AgentPrincipal, AgentClaimed, TaskReadAccess, ConversationInTask],
  errors: [ForbiddenError],
});

// ═══════════════════════════════════════════════════════════════════
// messages/received (notification)
// ═══════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════
// SHARED (app-caller) — dispatch_decision
//
// Per-message dispatch-authorization verdict resolved by the
// `messages/authorize` round-trip. Lives on the `messages.dispatch_decision`
// jsonb column server-side. Wire exposure is app-caller-only:
//
// - `MessageSchema` (SHARED, above) stays the canonical shape for non-app
//   callers — sender, recipient, any other agent. It does NOT carry
//   `dispatch_decision`. Recipients see only `forward` rows where they
//   appear in `recipients` (filter applied server-side); they have no need
//   to inspect the verdict.
// - `MessageWithDispatchDecisionSchema` (below) extends `MessageSchema` with
//   the verdict. The app caller for a task sees this shape.
//
// Two schemas (not a single optional field stripped at runtime) keep TS
// strict at non-app read sites: non-app consumers literally cannot reference
// `dispatchDecision` because the field is not in their type.
// ═══════════════════════════════════════════════════════════════════

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
// Strict, excess-rejecting guard over the verdict union. Decodes a value read
// from the `messages.dispatch_decision` JSONB column; an extra key signals a
// malformed verdict and rejects.
export const validateDispatchDecision = closedGuard(DispatchDecisionSchema);

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
