import { Schema, type Brand } from "effect";
import { agentId, agentOwnershipSchema } from "#identity/agents";
import { conversationId, messageId } from "#conversation";
import { AgentPrincipal, AppPrincipal } from "#identity/principals";
import { ActiveAgent } from "#identity/requirements";
import { messagePartsSchema } from "./parts.js";
import { defineNotification, defineRpc } from "#transport/descriptor";
import {
  ForbiddenError,
  errorPayloadFields,
  dateTimeStringSchema,
  formatString,
  stringEnum,
} from "#transport";

/** Represents lease id values. */
export type LeaseId = string & Brand.Brand<"LeaseId">;

/** Validates and decodes lease id values. */
export const leaseId: Schema.Schema<LeaseId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("LeaseId"),
  Schema.annotations({ description: "Branded LeaseId" }),
);

/** Represents dispatch id values. */
export type DispatchId = string & Brand.Brand<"DispatchId">;

/** Validates and decodes dispatch id values. */
export const dispatchId: Schema.Schema<DispatchId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("DispatchId"),
  Schema.annotations({ description: "Branded DispatchId" }),
);

/** Lease lifetime used when a grant omits an explicit timeout. */
export const DEFAULT_DISPATCH_LEASE_TIMEOUT_MS = 90_000;

/** Reports dispatch not found failures. */
export class DispatchNotFoundError extends Schema.TaggedError<DispatchNotFoundError>()(
  "DispatchNotFound",
  errorPayloadFields,
) {
  static readonly message = "Dispatch not found";
}

const dateTimeString = dateTimeStringSchema();
const agentOwnershipSchemaValue = agentOwnershipSchema();
const messageParts = messagePartsSchema();

const dispatchAdmissionDecisionSchema = Schema.Union(
  Schema.Struct({
    decision: Schema.Literal("grant"),
    leaseId: Schema.optional(leaseId),
    leaseTimeoutMs: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
    ),
    dispatchMessageId: Schema.optional(messageId),
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

/** Represents dispatch admission decision values. */
export type DispatchAdmissionDecision = Schema.Schema.Type<
  typeof dispatchAdmissionDecisionSchema
>;

const pendingMessageSchema = Schema.Struct({
  messageId: messageId,
  conversationId: conversationId,
  senderAgentId: agentId,
  createdAt: dateTimeString,
  receivedAt: dateTimeString,
  parts: Schema.optional(messageParts),
});

const pendingMessageArraySchema = Schema.Array(pendingMessageSchema).pipe(
  Schema.maxItems(100),
);

/**
 * Recipient admission request. The server returns immediately. A minted lease
 * emits `agent/dispatch/released` when the moderator verdict resolves;
 * `conversation_busy` creates no lease and emits no release.
 * @returns `{ leaseId, dispatchId }` when the conversation is reserved, or
 * `{ outcome: "conversation_busy" }` without a lease when it is already
 * reserved.
 */
export const dispatchRequest = defineRpc({
  name: "agent/dispatch/request",
  params: Schema.Struct({
    conversationId: conversationId,
    messageId: messageId,
    senderAgentId: agentId,
    parts: Schema.optional(messageParts),
    receivedAt: Schema.optional(dateTimeString),
    pending: Schema.optional(pendingMessageArraySchema),
    attempt: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
    ),
  }),
  result: Schema.Union(
    Schema.Struct({ leaseId: leaseId, dispatchId: dispatchId }),
    Schema.Struct({ outcome: Schema.Literal("conversation_busy") }),
  ),
  requires: [AgentPrincipal, ActiveAgent],
  errors: [],
});

const dispatchAuthorizeContextSchema = Schema.Struct({
  appId: Schema.String,
  conversationId: conversationId,
  recipient: agentOwnershipSchemaValue,
  message: Schema.Struct({
    id: messageId,
    senderAgentId: agentId,
    parts: Schema.optional(messageParts),
  }),
  attempt: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  receivedAt: Schema.optional(dateTimeString),
  pending: Schema.optional(pendingMessageArraySchema),
});

/** Defines the `app/dispatch/authorize` RPC contract. */
export const dispatchAuthorize = defineRpc({
  name: "app/dispatch/authorize",
  params: dispatchAuthorizeContextSchema,
  result: Schema.Struct({ admission: dispatchAdmissionDecisionSchema }),
  requires: [],
  errors: [ForbiddenError],
});

/** Defines the `agent/dispatch/released` notification contract. */
export const dispatchRelease = defineNotification({
  name: "agent/dispatch/released",
  params: Schema.Struct({
    dispatchId: dispatchId,
    leaseId: leaseId,
    verdict: dispatchAdmissionDecisionSchema,
    leaseTimeoutMs: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
    ),
  }),
});

/** Defines the `app/dispatch/lease-consumed` notification contract. */
export const dispatchLeaseConsumed = defineNotification({
  name: "app/dispatch/lease-consumed",
  params: Schema.Struct({
    dispatchId: dispatchId,
    leaseId: leaseId,
    conversationId: conversationId,
    messageId: messageId,
    consumedAt: dateTimeString,
  }),
});

/** Defines the `app/dispatch/lease-expired` notification contract. */
export const dispatchLeaseExpired = defineNotification({
  name: "app/dispatch/lease-expired",
  params: Schema.Struct({
    dispatchId: dispatchId,
    leaseId: leaseId,
    conversationId: conversationId,
    expiredAt: dateTimeString,
  }),
});

const leaseStateSchema = stringEnum([
  "PENDING",
  "CLAIMED",
  "GRANTED",
  "CONSUMED",
  "DENIED",
  "EXPIRED",
  "ABANDONED",
  "HOLD",
]);

const leaseRecordSchema = Schema.Struct({
  dispatchId: dispatchId,
  leaseId: leaseId,
  conversationId: conversationId,
  appId: Schema.String,
  recipientAgentId: agentId,
  moderatorConnectionId: Schema.String,
  state: leaseStateSchema,
  verdict: Schema.Union(dispatchAdmissionDecisionSchema, Schema.Null),
  mintedAt: dateTimeString,
  resolvedAt: Schema.Union(dateTimeString, Schema.Null),
  consumedAt: Schema.Union(dateTimeString, Schema.Null),
  consumedMessageId: Schema.Union(messageId, Schema.Null),
  expiredAt: Schema.Union(dateTimeString, Schema.Null),
  leaseTimeoutMs: Schema.Union(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
    Schema.Null,
  ),
});

/** Defines the `app/dispatch/lease/get` RPC contract. */
export const dispatchLeaseGet = defineRpc({
  name: "app/dispatch/lease/get",
  params: Schema.Struct({ dispatchId: dispatchId }),
  result: Schema.Struct({ lease: leaseRecordSchema }),
  requires: [AppPrincipal],
  errors: [DispatchNotFoundError, ForbiddenError],
});

/** Lists the agent callable dispatch rpc methods in dispatch order. */
export const agentCallableDispatchRpcMethods = [dispatchRequest] as const;

/** Lists the app callable dispatch rpc methods in dispatch order. */
export const appCallableDispatchRpcMethods = [dispatchLeaseGet] as const;

/** Lists the dispatch callback methods in dispatch order. */
export const dispatchCallbackMethods = [dispatchAuthorize] as const;

/** Lists the dispatch notification definitions. */
export const dispatchNotifications = [
  dispatchRelease,
  dispatchLeaseConsumed,
  dispatchLeaseExpired,
] as const;
