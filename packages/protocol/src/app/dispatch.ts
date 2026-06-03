import { Schema } from "effect";
import { AgentId, agentOwnershipSchema } from "../identity/methods.js";
import { ConversationId, MessageId, TaskId } from "../task/methods.js";
import { messagePartsSchema, logicalClockSchema } from "../task/methods.js";
import { LeaseId } from "../task/messages.js";
import {
  dateTimeStringSchema,
  brandedId,
  stringEnum,
} from "../schema-primitives.js";
import { defineNotification, defineRpc } from "../transport/method.js";
import {
  AgentPrincipal,
  AppPrincipal,
  AgentClaimed,
} from "../transport/principal.js";
import { ForbiddenError } from "../transport/wire-errors.js";

// ═══════════════════════════════════════════════════════════════════
// SHARED — dispatch value types + the dispatch error.
//
// The admission surface decouples the recipient's `dispatch/request` from
// moderator latency: the server mints a lease, acks immediately, forks the
// moderator round-trip, and emits `dispatch/release` as a notification when the
// verdict is in (or synthesized for default-grant / moderator-unavailable
// paths). `DispatchAdmissionDecisionSchema` is the verdict carried by the ack,
// the `dispatch/release` notification, and the `dispatches/get` lease record.
// ═══════════════════════════════════════════════════════════════════

const DateTimeString = dateTimeStringSchema();
const AgentOwnershipSchema = agentOwnershipSchema();
const MessagePartsSchema = messagePartsSchema();
const LogicalClockSchema = logicalClockSchema();

/** The referenced dispatch lease does not exist (or the caller is not its moderator). */
export class DispatchNotFoundError extends Schema.TaggedError<DispatchNotFoundError>()(
  "DispatchNotFound",
  {
    message: Schema.optional(Schema.String),
    data: Schema.optional(Schema.Unknown),
  },
) {
  static readonly message = "Dispatch lease not found";
}

/**
 * Branded dispatch identifier minted alongside the lease. Distinct from
 * the lease id so observability surfaces (`dispatches/get`,
 * `dispatches/consumed`, `dispatches/expired`) can reference an
 * admission attempt by a stable handle whose lease may have been
 * rolled back-and-re-granted within the same dispatch.
 */
export const DispatchId = brandedId("DispatchId");
export type DispatchId = Schema.Schema.Type<typeof DispatchId>;

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

const PendingMessageSchema = Schema.Struct({
  messageId: MessageId,
  conversationId: ConversationId,
  senderAgentId: AgentId,
  createdAt: DateTimeString,
  receivedAt: DateTimeString,
  clock: Schema.optional(LogicalClockSchema),
  parts: Schema.optional(MessagePartsSchema),
});

const PendingMessageArraySchema = Schema.Array(PendingMessageSchema).pipe(
  Schema.maxItems(100),
);

// ═══════════════════════════════════════════════════════════════════
// dispatch/request
// ═══════════════════════════════════════════════════════════════════

/**
 * Recipient → server admission request. The server returns an
 * immediate ack carrying `{leaseId, dispatchId}` and emits an out-of-
 * band `dispatch/release` notification carrying the verdict.
 *
 * Wire ordering: the ack and `dispatch/release` may race — the
 * recipient absorbs the race via a client-side ring buffer + per-
 * lease `Deferred` (see `packages/client/src/channel-core.ts`).
 *
 * - **Principal:** `AgentPrincipal` head + `AgentClaimed`. Agent-originated
 *   even though the recipient handler runs in the app layer: an agent posts a
 *   dispatch to a conversation it sends into.
 */
export const DispatchRequest = defineRpc({
  name: "dispatch/request",
  params: Schema.Struct({
    conversationId: ConversationId,
    messageId: MessageId,
    senderAgentId: AgentId,
    parts: Schema.optional(MessagePartsSchema),
    receivedAt: Schema.optional(DateTimeString),
    pending: Schema.optional(PendingMessageArraySchema),
    clock: Schema.optional(LogicalClockSchema),
    attempt: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
    ),
  }),
  result: Schema.Struct({ leaseId: LeaseId, dispatchId: DispatchId }),
  requires: [AgentPrincipal, AgentClaimed],
  errors: [],
});

// ═══════════════════════════════════════════════════════════════════
// dispatch/authorize (reverse callback)
// ═══════════════════════════════════════════════════════════════════

const DispatchAuthorizeContextSchema = Schema.Struct({
  taskId: TaskId,
  appId: Schema.String,
  conversationId: ConversationId,
  recipient: AgentOwnershipSchema,
  message: Schema.Struct({
    id: MessageId,
    senderAgentId: AgentId,
    parts: Schema.optional(MessagePartsSchema),
  }),
  attempt: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  receivedAt: Schema.optional(DateTimeString),
  clock: Schema.optional(LogicalClockSchema),
  pending: Schema.optional(PendingMessageArraySchema),
});

/**
 * Server → moderator request asking for the admission verdict. Carried
 * inside the forked moderator round-trip; failure / timeout in the
 * round-trip synthesizes a fail-closed `deny` verdict at
 * `LeaseRegistry.resolve`. The server emits this RPC only for a manifest
 * whose `dispatch_authorize` policy is `{ kind: "hook" }`.
 *
 * - **Principal:** none — a server→client reverse callback. The client serves
 *   it, the server does not gate it, so `requires` is empty.
 * @error ForbiddenError when the moderator rejects outright (collapsed to a fail-closed deny by the server)
 */
export const DispatchAuthorize = defineRpc({
  name: "dispatch/authorize",
  params: DispatchAuthorizeContextSchema,
  result: Schema.Struct({ admission: DispatchAdmissionDecisionSchema }),
  requires: [],
  errors: [ForbiddenError],
});

// ═══════════════════════════════════════════════════════════════════
// dispatch/release (notification)
// ═══════════════════════════════════════════════════════════════════

/**
 * Server → recipient verdict notification. Fire-and-forget on the wire. Always
 * emitted, including default-grant and synthesized infra-hold. The recipient
 * parks client-side on `leaseId` and unparks on this notification.
 *
 * `leaseTimeoutMs` is set on the `grant` arm only and is the post-grant TTL.
 * HOLD inherits the same TTL by ageing out via the standard EXPIRED path; no
 * `leaseTimeoutMs` field needed on the hold arm because the grant TTL has not
 * started yet (lease never reached GRANTED).
 */
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

// ═══════════════════════════════════════════════════════════════════
// dispatches/consumed + dispatches/expired (moderator-observability notifications)
// ═══════════════════════════════════════════════════════════════════

/**
 * Server → moderator notification: a lease was consumed by a
 * successful `messages/send`. Fires at `Claim.finalize` time, after
 * the durable insert lands, scoped to the moderator's connection only
 * (NOT broadcast). The moderator IS the authority for the lease, so
 * `messageId` visibility is in-scope.
 */
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

/**
 * Server → moderator notification: a granted lease aged out via post-
 * grant TTL without being consumed. Scoped to the moderator's
 * connection only. Distinct from DENIED (verdict-deny) and ABANDONED
 * (recipient disconnect) — EXPIRED is the inactivity outcome.
 */
export const DispatchesExpired = defineNotification({
  name: "dispatches/expired",
  params: Schema.Struct({
    dispatchId: DispatchId,
    leaseId: LeaseId,
    conversationId: ConversationId,
    expiredAt: DateTimeString,
  }),
});

// ═══════════════════════════════════════════════════════════════════
// dispatches/get
// ═══════════════════════════════════════════════════════════════════

/**
 * Lease-record snapshot returned by `dispatches/get`. Includes live
 * `leaseId` because the moderator IS the authority by design —
 * leaking the live id to the moderator is not an escalation surface.
 *
 * `state` mirrors the LeaseRegistry state machine (PENDING / CLAIMED
 * / GRANTED / CONSUMED / DENIED / EXPIRED / ABANDONED / HOLD).
 * `verdict` is null iff the lease has not yet been resolved (PENDING).
 */
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

/**
 * Moderator-only query for a specific lease record. Scope-enforced at
 * the handler: the calling connection must match the lease's
 * `moderatorConnectionId` (the binding tuple recorded at mint time);
 * non-moderator callers fail with `ForbiddenError`.
 *
 * - **Principal:** `AppPrincipal` head.
 * @error DispatchNotFoundError when the lease does not exist or the caller is not its moderator
 */
export const DispatchesGet = defineRpc({
  name: "dispatches/get",
  params: Schema.Struct({ dispatchId: DispatchId }),
  result: Schema.Struct({ lease: LeaseRecordSchema }),
  requires: [AppPrincipal],
  errors: [DispatchNotFoundError],
});
