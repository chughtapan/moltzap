import { Schema, type Brand } from "effect";
import { AgentId, agentOwnershipSchema } from "#identity/agents";
import { ConversationId, MessageId } from "#conversation";
import { AgentPrincipal, AppPrincipal } from "#identity/principals";
import { AgentClaimed } from "#identity/requirements";
import { messagePartsSchema } from "./parts.js";
import { TaskId } from "../task/ids.js";
import { defineNotification, defineRpc } from "../transport/method.js";
import { ForbiddenError } from "../transport/wire-errors.js";
import {
  dateTimeStringSchema,
  formatString,
  stringEnum,
} from "../transport/wire-string.js";

export type LeaseId = string & Brand.Brand<"LeaseId">;

export const LeaseId: Schema.Schema<LeaseId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("LeaseId"),
  Schema.annotations({ description: "Branded LeaseId" }),
);

export type DispatchId = string & Brand.Brand<"DispatchId">;

export const DispatchId: Schema.Schema<DispatchId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("DispatchId"),
  Schema.annotations({ description: "Branded DispatchId" }),
);

const errorPayloadFields = {
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
} as const;

export class DispatchNotFoundError extends Schema.TaggedError<DispatchNotFoundError>()(
  "DispatchNotFound",
  errorPayloadFields,
) {
  static readonly message = "Dispatch not found";
}

const DateTimeString = dateTimeStringSchema();
const AgentOwnershipSchema = agentOwnershipSchema();
const MessageParts = messagePartsSchema();

const DispatchAdmissionDecisionSchema = Schema.Union(
  Schema.Struct({
    decision: Schema.Literal("grant"),
    leaseId: Schema.optional(LeaseId),
    leaseTimeoutMs: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
    ),
    dispatchMessageId: Schema.optional(MessageId),
  }),
  Schema.Struct({
    decision: Schema.Literal("deny"),
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    decision: Schema.Literal("hold"),
    reason: Schema.optional(Schema.String),
  }),
);

export type DispatchAdmissionDecision = Schema.Schema.Type<
  typeof DispatchAdmissionDecisionSchema
>;

const PendingMessageSchema = Schema.Struct({
  messageId: MessageId,
  conversationId: ConversationId,
  senderAgentId: AgentId,
  createdAt: DateTimeString,
  receivedAt: DateTimeString,
  parts: Schema.optional(MessageParts),
});

const PendingMessageArraySchema = Schema.Array(PendingMessageSchema).pipe(
  Schema.maxItems(100),
);

/**
 * Recipient admission request. The server acks immediately and emits
 * `dispatch/release` when the moderator verdict resolves.
 */
export const DispatchRequest = defineRpc({
  name: "dispatch/request",
  params: Schema.Struct({
    conversationId: ConversationId,
    messageId: MessageId,
    senderAgentId: AgentId,
    parts: Schema.optional(MessageParts),
    receivedAt: Schema.optional(DateTimeString),
    pending: Schema.optional(PendingMessageArraySchema),
    attempt: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
    ),
  }),
  result: Schema.Struct({ leaseId: LeaseId, dispatchId: DispatchId }),
  requires: [AgentPrincipal, AgentClaimed],
  errors: [],
});

const DispatchAuthorizeContextSchema = Schema.Struct({
  taskId: TaskId,
  appId: Schema.String,
  conversationId: ConversationId,
  recipient: AgentOwnershipSchema,
  message: Schema.Struct({
    id: MessageId,
    senderAgentId: AgentId,
    parts: Schema.optional(MessageParts),
  }),
  attempt: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  receivedAt: Schema.optional(DateTimeString),
  pending: Schema.optional(PendingMessageArraySchema),
});

export const DispatchAuthorize = defineRpc({
  name: "dispatch/authorize",
  params: DispatchAuthorizeContextSchema,
  result: Schema.Struct({ admission: DispatchAdmissionDecisionSchema }),
  requires: [],
  errors: [ForbiddenError],
});

export const DispatchRelease = defineNotification({
  name: "dispatch/release",
  params: Schema.Struct({
    dispatchId: DispatchId,
    leaseId: LeaseId,
    verdict: DispatchAdmissionDecisionSchema,
    leaseTimeoutMs: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
    ),
  }),
});

export const DispatchesConsumed = defineNotification({
  name: "dispatches/consumed",
  params: Schema.Struct({
    dispatchId: DispatchId,
    leaseId: LeaseId,
    conversationId: ConversationId,
    messageId: MessageId,
    consumedAt: DateTimeString,
  }),
});

export const DispatchesExpired = defineNotification({
  name: "dispatches/expired",
  params: Schema.Struct({
    dispatchId: DispatchId,
    leaseId: LeaseId,
    conversationId: ConversationId,
    expiredAt: DateTimeString,
  }),
});

const LeaseStateSchema = stringEnum([
  "PENDING",
  "CLAIMED",
  "GRANTED",
  "CONSUMED",
  "DENIED",
  "EXPIRED",
  "ABANDONED",
  "HOLD",
]);

const LeaseRecordSchema = Schema.Struct({
  dispatchId: DispatchId,
  leaseId: LeaseId,
  conversationId: ConversationId,
  taskId: TaskId,
  appId: Schema.String,
  recipientAgentId: AgentId,
  moderatorConnectionId: Schema.String,
  state: LeaseStateSchema,
  verdict: Schema.Union(DispatchAdmissionDecisionSchema, Schema.Null),
  mintedAt: DateTimeString,
  resolvedAt: Schema.Union(DateTimeString, Schema.Null),
  consumedAt: Schema.Union(DateTimeString, Schema.Null),
  consumedMessageId: Schema.Union(MessageId, Schema.Null),
  expiredAt: Schema.Union(DateTimeString, Schema.Null),
  leaseTimeoutMs: Schema.Union(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
    Schema.Null,
  ),
});

export const DispatchesGet = defineRpc({
  name: "dispatches/get",
  params: Schema.Struct({ dispatchId: DispatchId }),
  result: Schema.Struct({ lease: LeaseRecordSchema }),
  requires: [AppPrincipal],
  errors: [DispatchNotFoundError, ForbiddenError],
});

export const agentCallableDispatchRpcMethods = [DispatchRequest] as const;

export const appCallableDispatchRpcMethods = [DispatchesGet] as const;

export const dispatchCallbackMethods = [DispatchAuthorize] as const;

export const dispatchNotifications = [
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
] as const;
