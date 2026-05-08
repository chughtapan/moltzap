// App-layer manifest. File outline:
//   1. App manifest schema (AppManifestSchema, AppManifest)
//   2. apps/* RPCs (AppsRegister, AppsAuthorizeDispatch [legacy])
//   3. task callback descriptor (TaskAuthorizeDispatch [legacy])
//   4. dispatch/* reshape additive descriptors (#529)
//   5. dispatches/* moderator-observability descriptors (#529)
//   6. Aggregator arrays
//
// Architect note (#529): the `apps/authorizeDispatch` (C→S) and
// `task/authorizeDispatch` (S→C) descriptors STAY in this PR. The
// reshape additive PR ships the new `dispatch/{request,authorize,
// release}` and `dispatches/{consumed,expired,get}` surfaces side-by-
// side; the cutover PR (row 13) deletes the legacy pair.
import { Type, type Static } from "@sinclair/typebox";
import { AgentId, AgentOwnershipSchema } from "../identity/methods.js";
import { ConversationId, MessageId, TaskId } from "../task/methods.js";
import { MessagePartsSchema, LogicalClockSchema } from "../task/methods.js";
import { DateTimeString, brandedId, stringEnum } from "../schema-primitives.js";
import { defineNotification, defineRpc } from "../transport/method.js";

// ── App manifest schema ──────────────────────────────────────────────

const AppManifestConversationSchema = Type.Object(
  {
    key: Type.String(),
    name: Type.String(),
    participantFilter: Type.Optional(stringEnum(["all", "initiator", "none"])),
  },
  { additionalProperties: false },
);

/**
 * Per-hook configuration entry. Both `task_authorize_dispatch` (legacy)
 * and `dispatch_authorize` (#529 additive) accept the same shape — only
 * `timeout_ms` is configurable. The cutover PR deletes the legacy key.
 *
 * Manifest dual-mode precedence: when a manifest declares BOTH
 * `task_authorize_dispatch` AND `dispatch_authorize`, the server prefers
 * `dispatch_authorize` and emits the new `dispatch/authorize` S→C RPC
 * (architect plan §4.3 + risk #8). The cutover PR removes the legacy key
 * outright, eliminating the ambiguity.
 */
const HookEntrySchema = Type.Object(
  {
    timeout_ms: Type.Optional(Type.Integer({ default: 5000, minimum: 1 })),
  },
  { additionalProperties: false },
);

/**
 * Manifest hook map. Dual-mode during the additive reshape PR (#529):
 * a moderator declares EITHER `task_authorize_dispatch` (routes via
 * legacy `task/authorizeDispatch` S→C RPC) OR `dispatch_authorize`
 * (routes via new `dispatch/authorize` S→C RPC). The server picks the
 * route by which key is present. The cutover PR removes the legacy
 * key; manifests carrying both during the transition prefer the new
 * key (architect §3.6, #529 acceptance §5).
 */
export const AppManifestSchema = Type.Object(
  {
    appId: Type.String(),
    name: Type.String(),
    description: Type.Optional(Type.String()),
    limits: Type.Optional(
      Type.Object(
        {
          maxParticipants: Type.Optional(Type.Integer({ default: 50 })),
        },
        { additionalProperties: false },
      ),
    ),
    conversations: Type.Optional(Type.Array(AppManifestConversationSchema)),
    hooks: Type.Optional(
      Type.Object(
        {
          task_authorize_dispatch: Type.Optional(HookEntrySchema),
          dispatch_authorize: Type.Optional(HookEntrySchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type AppManifest = Static<typeof AppManifestSchema>;

// ── apps/* RPCs ──────────────────────────────────────────────────────

export const AppsRegister = defineRpc({
  name: "apps/register",
  params: Type.Object(
    { manifest: AppManifestSchema },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { appId: Type.String() },
    { additionalProperties: false },
  ),
});

const DispatchAdmissionDecisionSchema = Type.Union([
  Type.Object(
    {
      decision: Type.Literal("grant"),
      leaseId: Type.Optional(Type.String()),
      leaseTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      dispatchMessageId: Type.Optional(MessageId),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      decision: Type.Literal("deny"),
      reason: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      decision: Type.Literal("hold"),
      reason: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

const PendingMessageSchema = Type.Object(
  {
    messageId: MessageId,
    conversationId: ConversationId,
    senderAgentId: AgentId,
    createdAt: DateTimeString,
    receivedAt: DateTimeString,
    clock: Type.Optional(LogicalClockSchema),
    parts: Type.Optional(MessagePartsSchema),
  },
  { additionalProperties: false },
);

const PendingMessageArraySchema = Type.Array(PendingMessageSchema, {
  maxItems: 100,
});

export const AppsAuthorizeDispatch = defineRpc({
  name: "apps/authorizeDispatch",
  params: Type.Object(
    {
      conversationId: ConversationId,
      messageId: MessageId,
      senderAgentId: AgentId,
      parts: Type.Optional(MessagePartsSchema),
      receivedAt: Type.Optional(DateTimeString),
      pending: Type.Optional(PendingMessageArraySchema),
      clock: Type.Optional(LogicalClockSchema),
      attempt: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { admission: DispatchAdmissionDecisionSchema },
    { additionalProperties: false },
  ),
});

const TaskAuthorizeDispatchContextSchema = Type.Object(
  {
    taskId: TaskId,
    appId: Type.String(),
    conversationId: ConversationId,
    recipient: AgentOwnershipSchema,
    message: Type.Object(
      {
        id: MessageId,
        senderAgentId: AgentId,
        parts: Type.Optional(MessagePartsSchema),
      },
      { additionalProperties: false },
    ),
    attempt: Type.Integer({ minimum: 0 }),
    receivedAt: Type.Optional(DateTimeString),
    clock: Type.Optional(LogicalClockSchema),
    pending: Type.Optional(PendingMessageArraySchema),
  },
  { additionalProperties: false },
);

export const TaskAuthorizeDispatch = defineRpc({
  name: "task/authorizeDispatch",
  params: TaskAuthorizeDispatchContextSchema,
  result: Type.Object(
    { admission: DispatchAdmissionDecisionSchema },
    { additionalProperties: false },
  ),
});

// ── dispatch/* reshape additive descriptors (#529) ──────────────────
//
// The new admission surface decouples the recipient's `dispatch/request`
// from moderator latency: the server mints a lease, acks immediately,
// forks the moderator round-trip, and emits `dispatch/release` as a
// notification when the verdict is in (or synthesized for default-grant
// / moderator-unavailable paths).
//
// Naming and shape constraints come from the parent plan's Final
// Decisions §1-§12 (see `/home/tapanc/.claude/plans/okay-now-look-that-
// swirling-snail.md`). All descriptors below are wire stubs — the
// implement-staff PR fills in registration into `appRpcMethods` /
// `taskCallbackMethods` / `appNotifications`, plus the AJV-backed
// validators (handled by `defineRpc` / `defineNotification` at module
// load).

/**
 * Branded lease identifier minted by `LeaseRegistry.mint`. UUIDv4 with
 * ≥122 bits entropy; the brand keeps it from being confused with
 * `MessageId` / `DispatchId` at type sites that consume both.
 */
export const LeaseId = brandedId("LeaseId");
export type LeaseId = Static<typeof LeaseId>;

/**
 * Branded dispatch identifier minted alongside the lease. Distinct from
 * the lease id so observability surfaces (`dispatches/get`,
 * `dispatches/consumed`, `dispatches/expired`) can reference an
 * admission attempt by a stable handle whose lease may have been
 * rolled back-and-re-granted within the same dispatch.
 */
export const DispatchId = brandedId("DispatchId");
export type DispatchId = Static<typeof DispatchId>;

/**
 * Recipient → server admission request. Replaces the synchronous-
 * verdict shape of legacy `apps/authorizeDispatch` with an immediate
 * ack carrying `{leaseId, dispatchId}` and an out-of-band
 * `dispatch/release` notification carrying the verdict.
 *
 * Wire ordering: the ack and `dispatch/release` may race — the
 * recipient absorbs the race via a client-side ring buffer added in
 * the cutover PR (#529 §6). This additive PR ships the server-side
 * surface only; clients still call legacy `apps/authorizeDispatch`.
 */
export const DispatchRequest = defineRpc({
  name: "dispatch/request",
  params: Type.Object(
    {
      conversationId: ConversationId,
      messageId: MessageId,
      senderAgentId: AgentId,
      parts: Type.Optional(MessagePartsSchema),
      receivedAt: Type.Optional(DateTimeString),
      pending: Type.Optional(PendingMessageArraySchema),
      clock: Type.Optional(LogicalClockSchema),
      attempt: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { leaseId: LeaseId, dispatchId: DispatchId },
    { additionalProperties: false },
  ),
});

/**
 * Server → moderator request asking for the admission verdict.
 * Successor of legacy `task/authorizeDispatch` (S→C). Carried inside
 * the forked moderator round-trip; failure / timeout in the round-trip
 * synthesizes a fail-closed `deny` verdict at `LeaseRegistry.resolve`.
 * Manifests opt in by declaring `hooks.dispatch_authorize` (additive
 * PR accepts this key alongside legacy `task_authorize_dispatch`; the
 * cutover PR drops the legacy key).
 */
export const DispatchAuthorize = defineRpc({
  name: "dispatch/authorize",
  params: TaskAuthorizeDispatchContextSchema,
  result: Type.Object(
    { admission: DispatchAdmissionDecisionSchema },
    { additionalProperties: false },
  ),
});

/**
 * Server → recipient verdict notification. Fire-and-forget on the wire
 * (Final Decision #2). Always emitted, including default-grant and
 * synthesized infra-hold (Final Decisions #3, #10). The recipient parks
 * client-side on `leaseId` and unparks on this notification.
 *
 * `leaseTimeoutMs` is set on the `grant` arm only and is the post-
 * grant TTL (Final Decision #9). HOLD inherits the same TTL by ageing
 * out via the standard EXPIRED path; no `leaseTimeoutMs` field needed
 * on the hold arm because the grant TTL has not started yet (lease
 * never reached GRANTED).
 */
export const DispatchRelease = defineNotification({
  name: "dispatch/release",
  params: Type.Object(
    {
      dispatchId: DispatchId,
      leaseId: LeaseId,
      verdict: DispatchAdmissionDecisionSchema,
      leaseTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
});

// ── dispatches/* moderator-observability surfaces (#529, decision #11) ─

/**
 * Server → moderator notification: a lease was consumed by a
 * successful `messages/send`. Fires at `Claim.finalize` time, after
 * the durable insert lands, scoped to the moderator's connection only
 * (NOT broadcast). The moderator IS the authority for the lease, so
 * `messageId` visibility is in-scope.
 */
export const DispatchesConsumed = defineNotification({
  name: "dispatches/consumed",
  params: Type.Object(
    {
      dispatchId: DispatchId,
      leaseId: LeaseId,
      conversationId: ConversationId,
      messageId: MessageId,
      consumedAt: DateTimeString,
    },
    { additionalProperties: false },
  ),
});

/**
 * Server → moderator notification: a granted lease aged out via post-
 * grant TTL without being consumed. Scoped to the moderator's
 * connection only. Distinct from DENIED (verdict-deny) and ABANDONED
 * (recipient disconnect) — EXPIRED is the inactivity outcome.
 */
export const DispatchesExpired = defineNotification({
  name: "dispatches/expired",
  params: Type.Object(
    {
      dispatchId: DispatchId,
      leaseId: LeaseId,
      conversationId: ConversationId,
      expiredAt: DateTimeString,
    },
    { additionalProperties: false },
  ),
});

/**
 * Lease-record snapshot returned by `dispatches/get`. Includes live
 * `leaseId` because the moderator IS the authority by design (#11) —
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

const LeaseRecordSchema = Type.Object(
  {
    dispatchId: DispatchId,
    leaseId: LeaseId,
    conversationId: ConversationId,
    taskId: TaskId,
    appId: Type.String(),
    recipientAgentId: AgentId,
    moderatorConnectionId: Type.String(),
    tmEndpointAddress: Type.String(),
    state: LeaseStateSchema,
    verdict: Type.Union([DispatchAdmissionDecisionSchema, Type.Null()]),
    mintedAt: DateTimeString,
    resolvedAt: Type.Union([DateTimeString, Type.Null()]),
    consumedAt: Type.Union([DateTimeString, Type.Null()]),
    consumedMessageId: Type.Union([MessageId, Type.Null()]),
    expiredAt: Type.Union([DateTimeString, Type.Null()]),
    leaseTimeoutMs: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

/**
 * Moderator-only query for a specific lease record. Scope-enforced at
 * the handler: the calling connection must match the lease's
 * `moderatorConnectionId` (the binding tuple recorded at mint time);
 * non-moderator callers fail with `ForbiddenError`.
 */
export const DispatchesGet = defineRpc({
  name: "dispatches/get",
  params: Type.Object(
    { dispatchId: DispatchId },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { lease: LeaseRecordSchema },
    { additionalProperties: false },
  ),
});

// ── Aggregators ─────────────────────────────────────────────────────
//
// During the additive PR every legacy descriptor stays registered
// alongside the new descriptors. The cutover PR (row 13) drops the
// legacy entries from these arrays.

export const appRpcMethods = [
  AppsRegister,
  AppsAuthorizeDispatch,
  DispatchRequest,
  DispatchesGet,
] as const;

export const taskCallbackMethods = [
  TaskAuthorizeDispatch,
  DispatchAuthorize,
] as const;

export const appNotifications = [
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
] as const;
