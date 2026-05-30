import { Data, Either, ParseResult, Schema } from "effect";
import { AgentId, agentOwnershipSchema } from "../identity/methods.js";
import { ConversationId, MessageId, TaskId } from "../task/methods.js";
import { messagePartsSchema, logicalClockSchema } from "../task/methods.js";
import {
  dateTimeStringSchema,
  brandedId,
  stringEnum,
  STRICT_DECODE,
} from "../schema-primitives.js";
import { defineNotification, defineRpc } from "../transport/method.js";

const DateTimeString = dateTimeStringSchema();
const AgentOwnershipSchema = agentOwnershipSchema();
const MessagePartsSchema = messagePartsSchema();
const LogicalClockSchema = logicalClockSchema();

const AppManifestConversationSchema = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  participantFilter: Schema.optional(stringEnum(["all", "initiator", "none"])),
});

/**
 * Per-hook configuration entry. Every hook key accepts the same
 * shape — only `timeout_ms` is configurable.
 */
const HookEntrySchema = Schema.Struct({
  timeout_ms: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  ),
});

/**
 * Manifest hook map. Three hook keys:
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
 * - `task_create` (task-creation gate) — selects the TM round-trip
 *   target for the per-task-request accept/reject verdict; emits the
 *   matching `task/create` S→C RPC. Distinct from the two per-message
 *   hooks: it gates the `waiting → active | failed` lifecycle
 *   transition, so it carries its own `timeout_ms` rather than
 *   borrowing the per-message tuning.
 *
 * All hook keys are optional. Default policy when `message_authorize`
 * is absent: `Forward { participants \ sender }`. When
 * `dispatch_authorize` is absent: `grant`. When `task_create` is
 * absent: the server uses the default app-hook timeout and the bound
 * app's registered `task/create` handler decides the verdict (the
 * boot-installed default app auto-accepts). See #560 for the
 * send-side design, #538/#536 for the receive-side history, and #683
 * for the task-creation gate.
 */
const AppManifestSchema = Schema.Struct({
  appId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  limits: Schema.optional(
    Schema.Struct({
      maxParticipants: Schema.optional(Schema.Number.pipe(Schema.int())),
    }),
  ),
  conversations: Schema.optional(Schema.Array(AppManifestConversationSchema)),
  hooks: Schema.optional(
    Schema.Struct({
      dispatch_authorize: Schema.optional(HookEntrySchema),
      message_authorize: Schema.optional(HookEntrySchema),
      task_create: Schema.optional(HookEntrySchema),
    }),
  ),
});

export type AppManifest = Schema.Schema.Type<typeof AppManifestSchema>;

const decodeAppManifest = Schema.decodeUnknownEither(AppManifestSchema);

class AppManifestInvalid extends Data.TaggedError("AppManifestInvalid")<{
  readonly errors: readonly string[];
}> {}

export type AppManifestValidationResult = Either.Either<
  AppManifest,
  AppManifestInvalid
>;

/**
 * Strict manifest validation. Decodes with `{ onExcessProperty: "error" }`
 * (the former `new Ajv({ strict: true })` + `additionalProperties:false`
 * rejected extra keys); on failure surfaces every `ParseError` leaf via
 * `ParseResult.ArrayFormatter.formatErrorSync` (one issue → one string),
 * replacing the AJV `.errors` `${instancePath} ${message}` adapter.
 */
export function validateAppManifest(
  value: unknown,
): AppManifestValidationResult {
  return Either.mapLeft(
    decodeAppManifest(value, STRICT_DECODE),
    (parseError) => {
      const issues = ParseResult.ArrayFormatter.formatErrorSync(parseError).map(
        (issue) => `${issue.path.join("/") || "/"} ${issue.message}`,
      );
      return new AppManifestInvalid({
        errors: issues.length > 0 ? issues : ["unknown validation failure"],
      });
    },
  );
}

// ── apps/* RPCs ──────────────────────────────────────────────────────

/**
 * Register an app manifest for the current connection.
 */
export const AppsRegister = defineRpc({
  name: "apps/register",
  params: Schema.Struct({ manifest: AppManifestSchema }),
  result: Schema.Struct({ appId: Schema.String }),
});

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

import { LeaseId } from "../task/messages.js";

/**
 * Branded dispatch identifier minted alongside the lease. Distinct from
 * the lease id so observability surfaces (`dispatches/get`,
 * `dispatches/consumed`, `dispatches/expired`) can reference an
 * admission attempt by a stable handle whose lease may have been
 * rolled back-and-re-granted within the same dispatch.
 */
export const DispatchId = brandedId("DispatchId");
export type DispatchId = Schema.Schema.Type<typeof DispatchId>;

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
  result: Schema.Struct({ admission: DispatchAdmissionDecisionSchema }),
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
  params: Schema.Struct({
    dispatchId: DispatchId,
    leaseId: LeaseId,
    verdict: DispatchAdmissionDecisionSchema,
    leaseTimeoutMs: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
    ),
  }),
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
 */
export const DispatchesGet = defineRpc({
  name: "dispatches/get",
  params: Schema.Struct({ dispatchId: DispatchId }),
  result: Schema.Struct({ lease: LeaseRecordSchema }),
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

const MessagesAuthorizeContextSchema = Schema.Struct({
  taskId: TaskId,
  appId: Schema.String,
  conversationId: ConversationId,
  message: Schema.Struct({
    id: MessageId,
    senderAgentId: AgentId,
    parts: Schema.optional(MessagePartsSchema),
  }),
  receivedAt: Schema.optional(DateTimeString),
  clock: Schema.optional(LogicalClockSchema),
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
  result: Schema.Struct({ verdict: MessagesAuthorizeVerdictSchema }),
});

// ── task/create (TM recruitment) ────────────────────────────────────
//
// Issue #683: agent-driven `task/request` creates a task in
// `"waiting"` state and forks this wire callback to the registered
// TM. The TM responds with an accept/reject verdict; on accept the
// task transitions to `"active"` and the TM is responsible for
// creating any conversations (via the TM-only
// `task/conversation/create`). The verdict shape mirrors the rest
// of the wire-callback family — same fail-closed envelope, same
// timeout-synthesizes-reject posture.

const TaskCreateContextSchema = Schema.Struct({
  taskId: TaskId,
  initiatorAgentId: AgentId,
  invitedAgentIds: Schema.Array(AgentId),
  initialConversation: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      participants: Schema.optional(Schema.Array(AgentId)),
    }),
  ),
  receivedAt: Schema.optional(DateTimeString),
});

const TaskCreateVerdictSchema = Schema.Union(
  Schema.Struct({ decision: Schema.Literal("accept") }),
  Schema.Struct({
    decision: Schema.Literal("reject"),
    // Bound matches `TaskFailedNotificationDefinition.reason`
    // (1..256). The server forwards this verdict reason verbatim
    // into the `task/failed` notification; an unbounded or empty
    // reason here would produce a `task/failed` frame the client
    // decoder rejects (the notification would silently never
    // decode at subscribers). Keeping the two schemas in lockstep
    // makes that mismatch unrepresentable.
    reason: Schema.optional(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
    ),
  }),
);

/**
 * Server → TM round-trip asking whether the TM accepts a newly
 * requested task. Triggered from the `task/request` handler after
 * the task row is inserted (status `"waiting"`) and before the
 * requester observes any state.
 *
 * The TM owns the post-accept lifecycle:
 *   - On `accept` the server transitions the task to `"active"`
 *     and fires `task/created` to the requester. The TM SHOULD
 *     then call `task/conversation/create` to honor the
 *     requester's `initialConversation` hint if it chose to.
 *   - On `reject` (or timeout / RPC error / decode failure) the
 *     server transitions the task to `"failed"` and fires
 *     `task/failed` to the requester.
 *
 * Fail-closed envelope mirrors `DispatchAuthorize` /
 * `MessagesAuthorize`: timeout synthesizes
 * `{ decision: "reject", reason: "timeout" }`; an unknown app or
 * RPC/decode failure synthesizes `reason: "tm_unreachable"`.
 *
 * Durability note: the `task/request` handler inserts the task row
 * (`waiting`) BEFORE this callback's network round-trip, and the
 * terminal `setStatus` runs AFTER it. The sequence is not atomic
 * (the callback is a network call, not a DB op), so a crash or fiber
 * interrupt in that window can strand a task in `waiting`. Stranded
 * waiting tasks are invisible to delivery (no conversation, no
 * participants observe them) and are reaped by follow-up work (the
 * stale-waiting-task sweep, #684).
 */
export const TaskCreate = defineRpc({
  name: "task/create",
  params: TaskCreateContextSchema,
  result: Schema.Struct({ verdict: TaskCreateVerdictSchema }),
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
  TaskCreate,
] as const;

export const appNotifications = [
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
] as const;
