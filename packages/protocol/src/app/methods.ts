import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Data, Either } from "effect";
import { AgentId, agentOwnershipSchema } from "../identity/methods.js";
import { ConversationId, MessageId, TaskId } from "../task/methods.js";
import { messagePartsSchema, logicalClockSchema } from "../task/methods.js";
import {
  dateTimeStringSchema,
  brandedId,
  stringEnum,
} from "../schema-primitives.js";
import { defineNotification, defineRpc } from "../transport/method.js";

const DateTimeString = dateTimeStringSchema();
const AgentOwnershipSchema = agentOwnershipSchema();
const MessagePartsSchema = messagePartsSchema();
const LogicalClockSchema = logicalClockSchema();

const AppManifestConversationSchema = Type.Object(
  {
    key: Type.String(),
    name: Type.String(),
    participantFilter: Type.Optional(stringEnum(["all", "initiator", "none"])),
  },
  { additionalProperties: false },
);

/**
 * Per-hook configuration entry. `dispatch_authorize` accepts the
 * shape — only `timeout_ms` is configurable.
 */
const HookEntrySchema = Type.Object(
  {
    timeout_ms: Type.Optional(Type.Integer({ default: 5000, minimum: 1 })),
  },
  { additionalProperties: false },
);

/**
 * Manifest hook map. Two hook keys:
 *
 * - `dispatch_authorize` (receive-side) — selects the moderator round-
 *   trip target for per-recipient admission verdicts; emits the
 *   matching `dispatch/authorize` S→C RPC.
 * - `message_authorize` (send-side) — selects the TM round-trip target
 *   for per-message fan-out verdicts; emits the matching
 *   `messages/authorize` S→C RPC. Restores the send-side gate that
 *   Phase 9b (#461) deleted by removing `apps/onBeforeMessageDelivery`
 *   without an equivalent on the new wire surface. Verdict is the
 *   minimum-viable subset of #142's 5-arm `TaskManagerAction`:
 *   `Forward { recipients } | Block { reason }`.
 *
 * Both hook keys are optional. Default policy when `message_authorize`
 * is absent: `Forward { participants \ sender }`. Default policy when
 * `dispatch_authorize` is absent: `grant`. See #560 for the send-side
 * design and #538/#536 for the receive-side history.
 */
const AppManifestSchema = Type.Object(
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
          dispatch_authorize: Type.Optional(HookEntrySchema),
          message_authorize: Type.Optional(HookEntrySchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type AppManifest = Static<typeof AppManifestSchema>;

const appManifestValidator = addFormats(
  new Ajv({ strict: true, allErrors: true }),
).compile<AppManifest>(AppManifestSchema);

const formatAppManifestError = (error: {
  readonly instancePath?: string;
  readonly message?: string;
}): string =>
  `${error.instancePath || "/"} ${error.message ?? "validation failed"}`;

class AppManifestInvalid extends Data.TaggedError("AppManifestInvalid")<{
  readonly errors: readonly string[];
}> {}

export type AppManifestValidationResult = Either.Either<
  AppManifest,
  AppManifestInvalid
>;

const currentAppManifestErrors = (): readonly string[] => {
  const errors = (appManifestValidator.errors ?? []).map(
    formatAppManifestError,
  );
  return errors.length > 0 ? errors : ["unknown validation failure"];
};

const validateAppManifestValue = Either.liftPredicate(
  (value: unknown): value is AppManifest => appManifestValidator(value),
  () => new AppManifestInvalid({ errors: currentAppManifestErrors() }),
);

export function validateAppManifest(
  value: unknown,
): AppManifestValidationResult {
  return validateAppManifestValue(value);
}

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

const DispatchAuthorizeContextSchema = Type.Object(
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

// ── dispatch/* admission descriptors ────────────────────────────────
//
// The admission surface decouples the recipient's `dispatch/request`
// from moderator latency: the server mints a lease, acks immediately,
// forks the moderator round-trip, and emits `dispatch/release` as a
// notification when the verdict is in (or synthesized for default-grant
// / moderator-unavailable paths).
//
// Naming and shape constraints come from the parent plan's Final
// Decisions §1-§12 (see `/home/tapanc/.claude/plans/okay-now-look-that-
// swirling-snail.md`).

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
 * Recipient → server admission request. The server returns an
 * immediate ack carrying `{leaseId, dispatchId}` and emits an out-of-
 * band `dispatch/release` notification carrying the verdict.
 *
 * Wire ordering: the ack and `dispatch/release` may race — the
 * recipient absorbs the race via a client-side ring buffer + per-
 * lease `Deferred` (see `packages/client/src/channel-core.ts`).
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
 * Server → moderator request asking for the admission verdict. Carried
 * inside the forked moderator round-trip; failure / timeout in the
 * round-trip synthesizes a fail-closed `deny` verdict at
 * `LeaseRegistry.resolve`. Manifests opt in by declaring
 * `hooks.dispatch_authorize`.
 */
// Spec D3 R14b — REQUIRED slot. `MoltZapTMClient` constructor demands a
// handler at type level; vacuous-deny moderators must wire it explicitly.
export const DispatchAuthorize = defineRpc({
  name: "dispatch/authorize",
  params: DispatchAuthorizeContextSchema,
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

// ── messages/authorize (send-side fan-out gate) ─────────────────────
//
// #560: restore the send-side authority gate that Phase 9b (#461)
// deleted. The TM declares per-message fan-out policy as a verdict;
// the server enforces it via the existing `NetworkSendService.broad-
// cast` machinery. Verdict shape is the 2-arm subset of #142:
// `Forward { recipients } | Block { reason }`. The remaining arms
// (`Modify | Close | AttachConversation`) defer to follow-ups; the
// 2-arm shape is forward-extensible.
//
// Symmetric to `dispatch/authorize`: same context shape (`taskId`,
// `appId`, `conversationId`, `message`, `receivedAt`, `clock`), same
// fail-closed timeout posture (timeout / RPC error → synthesize Block
// with reason `tm_unreachable`), different verdict union.

const MessagesAuthorizeContextSchema = Type.Object(
  {
    taskId: TaskId,
    appId: Type.String(),
    conversationId: ConversationId,
    message: Type.Object(
      {
        id: MessageId,
        senderAgentId: AgentId,
        parts: Type.Optional(MessagePartsSchema),
      },
      { additionalProperties: false },
    ),
    receivedAt: Type.Optional(DateTimeString),
    clock: Type.Optional(LogicalClockSchema),
  },
  { additionalProperties: false },
);

const MessagesAuthorizeVerdictSchema = Type.Union([
  Type.Object(
    {
      decision: Type.Literal("Forward"),
      recipients: Type.Array(AgentId),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      decision: Type.Literal("Block"),
      reason: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

/**
 * Server → TM round-trip asking for the per-message fan-out verdict.
 * Triggered from `MessageService.sendCommit` after the durable insert
 * lands and before the broadcast. Manifests opt in by declaring
 * `hooks.message_authorize`. Failure / timeout in the round-trip
 * synthesizes a fail-closed `Block { reason: "tm_unreachable" }`
 * verdict at the AppHost envelope (mirrors `runAuthorizeDispatch`'s
 * `wrapHookEffectWithEnvelope` posture).
 *
 * `Forward { recipients }` MUST be a subset of the conversation's
 * participants; the server does not re-fan to non-participants.
 * `Forward { recipients: [] }` is legal — message lands in the
 * sender's transcript but is delivered to no one else.
 */
// Spec D3 R14b — REQUIRED slot. Symmetric with DispatchAuthorize.
export const MessagesAuthorize = defineRpc({
  name: "messages/authorize",
  params: MessagesAuthorizeContextSchema,
  result: Type.Object(
    { verdict: MessagesAuthorizeVerdictSchema },
    { additionalProperties: false },
  ),
});

// ── Aggregators ─────────────────────────────────────────────────────

export const appRpcMethods = [
  AppsRegister,
  DispatchRequest,
  DispatchesGet,
] as const;

export const taskCallbackMethods = [
  DispatchAuthorize,
  MessagesAuthorize,
] as const;

export const appNotifications = [
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
] as const;
