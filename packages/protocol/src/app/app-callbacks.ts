import { Schema } from "effect";
import { AgentId } from "../identity/methods.js";
import { ConversationId, MessageId } from "../conversation/index.js";
import { TaskId } from "../task/methods.js";
import { messagePartsSchema } from "../message/index.js";
import { dateTimeStringSchema } from "../transport/wire-string.js";
import { defineRpc } from "../transport/method.js";
import { ForbiddenError } from "../transport/wire-errors.js";

// ═══════════════════════════════════════════════════════════════════
// SHARED — the two server→TM reverse callbacks: `messages/authorize`
// (send-side fan-out gate) and `task/create` (TM recruitment).
//
// Both are server→client reverse callbacks: the TM serves them, the server does
// not gate them, so each carries an empty `requires`. Both share the
// fail-closed envelope posture: timeout / RPC error / decode failure
// synthesizes a deterministic deny-equivalent verdict at the AppHost envelope.
// ═══════════════════════════════════════════════════════════════════

const DateTimeString = dateTimeStringSchema();
const MessagePartsSchema = messagePartsSchema();

// ═══════════════════════════════════════════════════════════════════
// messages/authorize (send-side fan-out gate)
//
// The send-side authority gate: the TM declares per-message fan-out policy as a
// verdict; the server enforces it via the `NetworkSendService.broadcast`
// machinery. Verdict shape is `Forward { recipients } | Block { reason }`.
// Symmetric to `dispatch/authorize`: same context shape, same fail-closed
// timeout posture (timeout / RPC error → synthesize Block with reason
// `app_unreachable`), different verdict union.
// ═══════════════════════════════════════════════════════════════════

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
 * lands and before the broadcast. The server emits this RPC only for a
 * manifest whose `message_authorize` policy is `{ kind: "hook" }`.
 * Failure / timeout in the round-trip synthesizes a fail-closed
 * `Block { reason: "app_unreachable" }` verdict at the AppHost envelope
 * (mirrors the `dispatch/authorize` `wrapHookEffectWithEnvelope`
 * posture).
 *
 * `Forward { recipients }` MUST be a subset of the conversation's
 * participants; the server does not re-fan to non-participants.
 * `Forward { recipients: [] }` is legal — message lands in the
 * sender's transcript but is delivered to no one else.
 *
 * - **Principal:** none — a server→client reverse callback.
 * @error ForbiddenError when the moderator rejects (collapsed to a fail-closed Block by the server)
 */
export const MessagesAuthorize = defineRpc({
  name: "messages/authorize",
  params: MessagesAuthorizeContextSchema,
  result: Schema.Struct({ verdict: MessagesAuthorizeVerdictSchema }),
  requires: [],
  errors: [ForbiddenError],
});

// ═══════════════════════════════════════════════════════════════════
// task/create (TM recruitment)
//
// Agent-driven `task/request` creates a task in `"waiting"` state and forks
// this wire callback to the registered TM. The TM responds with an
// accept/reject verdict; on accept the task transitions to `"active"` and the
// TM is responsible for creating any conversations (via the TM-only
// `task/conversation/create`). The verdict shape mirrors the rest of the
// wire-callback family — same fail-closed envelope, same
// timeout-synthesizes-reject posture.
// ═══════════════════════════════════════════════════════════════════

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
 * RPC/decode failure synthesizes `reason: "app_unreachable"`.
 *
 * Durability note: the `task/request` handler inserts the task row
 * (`waiting`) BEFORE this callback's network round-trip, and the
 * terminal `setStatus` runs AFTER it. The sequence is not atomic
 * (the callback is a network call, not a DB op), so a crash or fiber
 * interrupt in that window can strand a task in `waiting`. Stranded
 * waiting tasks are invisible to delivery (no conversation, no
 * participants observe them) and would be reaped by a stale-waiting-task
 * sweep.
 *
 * - **Principal:** none — a server→client reverse callback.
 * @error ForbiddenError when the TM rejects (collapsed to a fail-closed reject by the server)
 */
export const TaskCreate = defineRpc({
  name: "task/create",
  params: TaskCreateContextSchema,
  result: Schema.Struct({ verdict: TaskCreateVerdictSchema }),
  requires: [],
  errors: [ForbiddenError],
});
