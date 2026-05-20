import { Data } from "effect";
import { Type, type Static } from "@sinclair/typebox";
import {
  stringEnum,
  dateTimeStringSchema,
  brandedId,
} from "../schema-primitives.js";
import { AgentId } from "../identity/agents.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import {
  registerErrorClass,
  type RpcErrorPayload,
} from "../transport/wire-errors.js";
import {
  ConversationId,
  ConversationTypeEnum,
  agentParticipantRefSchema,
  conversationSchema,
  MessageId,
} from "./conversations.js";
import { messagePartsSchema, messageSchema } from "./messages.js";
// Direct per-file imports (NOT via the capabilities barrel) to keep the
// runtime dep graph one-way; see conversations.ts for the rationale.
import {
  ConversationCreateAuthorization,
  type ObtainConversationCreateAuthorizationInput,
} from "./capabilities/conversation-create-authorization.js";
import { ConversationInTask } from "./capabilities/conversation-in-task.js";
import {
  MessageSendPermission,
  type ObtainMessageSendPermissionInput,
} from "./capabilities/message-send-permission.js";
import { TaskReadAccess } from "./capabilities/task-read-access.js";
import { TmAuthority } from "./capabilities/tm-authority.js";

/**
 * Branded UUID for the per-app identifier. Introduced by Spec D1
 * (issue #598) so the reshaped `task/create` wire and downstream
 * lookups (app-tm-registry → `tm_endpoint_address`) cannot accidentally
 * accept a non-UUID string. The old `tasks/create` keeps its
 * un-branded `appId: Type.Optional(Type.String())` shape during the
 * D1 transitional window; D3 (#600) deletes that surface and brands
 * every remaining call site.
 */
export const AppId = brandedId("AppId");
export type AppId = Static<typeof AppId>;

/**
 * The single server-bundled default app. Every DM and Group lives
 * under this app from Spec D1 forward; the per-conversation `type`
 * enum (`dm` / `group`) becomes a display-only label derived from
 * participant count and retires in D3.
 *
 * UUID v4 fixed by spec body Goal 4 (#598). The constant is the
 * source of truth — the server registers `makeDefaultMessageAuthorizeHook`
 * against the TM address derived from this UUID, and the
 * `TaskCreate` dedup query keys off it.
 *
 * Greenfield schema (per project memory
 * `project_layered_refactor_packaging.md`): no prior rows under the
 * legacy `DEFAULT_DM_TM_ADDRESS` / `DEFAULT_GROUP_TM_ADDRESS`
 * constants exist at cutover, so dedup operates only on rows
 * created under `DEFAULT_APP_ID` from D1 forward.
 */
export const DEFAULT_APP_ID = "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb" as AppId;

const DateTimeString = dateTimeStringSchema();
const AgentParticipantRefSchema = agentParticipantRefSchema();
const ConversationSchema = conversationSchema();
const MessagePartsSchema = messagePartsSchema();
const MessageSchema = messageSchema();

export const TaskId = brandedId("TaskId");
export type TaskId = Static<typeof TaskId>;

export class TaskClosedError extends Data.TaggedError(
  "TaskClosed",
)<RpcErrorPayload> {
  static readonly code = -32020;
  static readonly message = "Task is closed";
}
registerErrorClass(TaskClosedError);

export class HookBlockedError extends Data.TaggedError(
  "HookBlocked",
)<RpcErrorPayload> {
  static readonly code = -32019;
  static readonly message = "Hook blocked the dispatch";
}
registerErrorClass(HookBlockedError);

/**
 * Spec D1 (#598) NEW invariant: `task/conversation/create` and
 * `task/conversation/participants/add` reject agents who are not
 * already in `task_participants`. The error tag lets clients
 * distinguish "wrong agentId shape" (InvalidParams) from "agent
 * exists but is not admitted to this task" (this tag) without
 * parsing message strings.
 */
export class ParticipantNotAdmittedError extends Data.TaggedError(
  "ParticipantNotAdmitted",
)<RpcErrorPayload> {
  static readonly code = -32023;
  static readonly message = "Agent is not admitted to the task";
}
registerErrorClass(ParticipantNotAdmittedError);

/**
 * Logical time frontier per delivery domain (usually a conversation):
 * monotonic `epoch` + per-participant observed counts in `vector`.
 */
const LogicalClockSchema = Type.Object(
  {
    domainId: Type.String({ minLength: 1 }),
    epoch: Type.Integer({ minimum: 0 }),
    vector: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export type LogicalClock = Static<typeof LogicalClockSchema>;

export function logicalClockSchema(): typeof LogicalClockSchema {
  return LogicalClockSchema;
}

const TmTypeEnum = stringEnum(["self", "default-dm", "default-group"]);
export type TmType = (typeof TmTypeEnum)["static"];

// Mirrors the `task_status` DB enum.
const TaskStatusEnum = stringEnum(["waiting", "active", "failed", "closed"]);

export type TaskStatus = Static<typeof TaskStatusEnum>;

const TaskSchema = Type.Object(
  {
    id: TaskId,
    appId: Type.Union([Type.String(), Type.Null()]),
    initiatorAgentId: AgentId,
    status: TaskStatusEnum,
    // The persisted task output exposes `tmEndpointAddress` (a branded
    // `EndpointAddress` string). The public `tasks/create` request does
    // NOT take an address directly; it takes a `tmType` enum and the
    // server derives the address (Phase 9b R16, PR #461).
    tmEndpointAddress: Type.String({ minLength: 1 }),
    startedAt: Type.Union([DateTimeString, Type.Null()]),
    endedAt: Type.Union([DateTimeString, Type.Null()]),
    createdAt: DateTimeString,
  },
  { additionalProperties: false },
);

export type Task = Static<typeof TaskSchema>;

// `admittedAt = null` ⇒ invited but not yet admitted.
const TaskParticipantSchema = Type.Object(
  {
    taskId: TaskId,
    agentId: AgentId,
    admittedAt: Type.Union([DateTimeString, Type.Null()]),
  },
  { additionalProperties: false },
);

export type TaskParticipant = Static<typeof TaskParticipantSchema>;

export const TasksCreate = defineRpc({
  name: "tasks/create",
  params: Type.Object(
    {
      appId: Type.Optional(Type.String()),
      invitedAgentIds: Type.Optional(Type.Array(AgentId)),
      tmType: TmTypeEnum,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({ task: TaskSchema }, { additionalProperties: false }),
});

export const TasksGet = defineRpc({
  name: "tasks/get",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object(
    {
      task: TaskSchema,
      participants: Type.Array(TaskParticipantSchema),
    },
    { additionalProperties: false },
  ),
  capabilities: [
    {
      tag: TaskReadAccess,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return { taskId: p.taskId, callerAgentId: c.auth.agentId };
      },
    },
  ] as const,
});

export const TasksList = defineRpc({
  name: "tasks/list",
  params: Type.Object(
    {
      appId: Type.Optional(Type.String()),
      status: Type.Optional(TaskStatusEnum),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { tasks: Type.Array(TaskSchema) },
    { additionalProperties: false },
  ),
});

export const TasksClose = defineRpc({
  name: "tasks/close",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object({ task: TaskSchema }, { additionalProperties: false }),
  capabilities: [
    {
      tag: TmAuthority,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return { taskId: p.taskId, callerAgentId: c.auth.agentId };
      },
    },
  ] as const,
});

export const TasksCreateConversation = defineRpc({
  name: "tasks/createConversation",
  params: Type.Object(
    {
      taskId: TaskId,
      type: ConversationTypeEnum,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      participants: Type.Array(AgentParticipantRefSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { conversation: ConversationSchema },
    { additionalProperties: false },
  ),
  capabilities: [
    {
      tag: TmAuthority,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return { taskId: p.taskId, callerAgentId: c.auth.agentId };
      },
    },
    {
      tag: ConversationCreateAuthorization,
      argsOf: (
        params: unknown,
        ctx: unknown,
      ): ObtainConversationCreateAuthorizationInput => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly type: "dm" | "group";
          readonly participants: ReadonlyArray<{ readonly id: string }>;
        };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return {
          type: p.type,
          agentIds: p.participants.map((x) => x.id as AgentId),
          creatorAgentId: c.auth.agentId,
        };
      },
    },
  ] as const,
});

export const TasksCloseConversation = defineRpc({
  name: "tasks/closeConversation",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
  capabilities: [
    {
      tag: TmAuthority,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return { taskId: p.taskId, callerAgentId: c.auth.agentId };
      },
    },
    {
      tag: ConversationInTask,
      argsOf: (params: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly taskId: TaskId;
          readonly conversationId: ConversationId;
        };
        return { taskId: p.taskId, conversationId: p.conversationId };
      },
    },
  ] as const,
});

export const TasksAddParticipant = defineRpc({
  name: "tasks/addParticipant",
  params: Type.Object(
    {
      taskId: TaskId,
      agentId: AgentId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { participant: TaskParticipantSchema },
    { additionalProperties: false },
  ),
  capabilities: [
    {
      tag: TmAuthority,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return { taskId: p.taskId, callerAgentId: c.auth.agentId };
      },
    },
  ] as const,
});

export const TasksRemoveParticipant = defineRpc({
  name: "tasks/removeParticipant",
  params: Type.Object(
    {
      taskId: TaskId,
      agentId: AgentId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
  capabilities: [
    {
      tag: TmAuthority,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return { taskId: p.taskId, callerAgentId: c.auth.agentId };
      },
    },
  ] as const,
});

export const TasksStoreMessage = defineRpc({
  name: "tasks/storeMessage",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
      senderAgentId: AgentId,
      parts: MessagePartsSchema,
      replyToId: Type.Optional(MessageId),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { message: MessageSchema },
    { additionalProperties: false },
  ),
  capabilities: [
    {
      tag: TmAuthority,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return { taskId: p.taskId, callerAgentId: c.auth.agentId };
      },
    },
    {
      tag: ConversationInTask,
      argsOf: (params: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly taskId: TaskId;
          readonly conversationId: ConversationId;
        };
        return { taskId: p.taskId, conversationId: p.conversationId };
      },
    },
    {
      tag: MessageSendPermission,
      argsOf: (params: unknown): ObtainMessageSendPermissionInput => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly taskId: TaskId;
          readonly conversationId: ConversationId;
          readonly senderAgentId: AgentId;
          readonly replyToId?: Static<typeof MessageId>;
        };
        return {
          taskId: p.taskId,
          conversationId: p.conversationId,
          senderAgentId: p.senderAgentId,
          replyToId: p.replyToId,
        };
      },
    },
  ] as const,
});

export const TasksGetMessages = defineRpc({
  name: "tasks/getMessages",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      messages: Type.Array(MessageSchema),
      hasMore: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  capabilities: [
    {
      tag: TaskReadAccess,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return { taskId: p.taskId, callerAgentId: c.auth.agentId };
      },
    },
    {
      tag: ConversationInTask,
      argsOf: (params: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly taskId: TaskId;
          readonly conversationId: ConversationId;
        };
        return { taskId: p.taskId, conversationId: p.conversationId };
      },
    },
  ] as const,
});

export const TasksGetMessagesSince = defineRpc({
  name: "tasks/getMessagesSince",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
      sinceSeq: Type.String({
        description: "Snowflake seq cursor (string-encoded BIGINT)",
      }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      messages: Type.Array(MessageSchema),
      hasMore: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  capabilities: [
    {
      tag: TaskReadAccess,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return { taskId: p.taskId, callerAgentId: c.auth.agentId };
      },
    },
    {
      tag: ConversationInTask,
      argsOf: (params: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly taskId: TaskId;
          readonly conversationId: ConversationId;
        };
        return { taskId: p.taskId, conversationId: p.conversationId };
      },
    },
  ] as const,
});

const TaskFailedNotificationSchema = Type.Object(
  { taskId: TaskId },
  { additionalProperties: false },
);

const TaskClosedNotificationSchema = Type.Object(
  { task: TaskSchema },
  { additionalProperties: false },
);

/**
 * Pushed when a task fails before becoming ready.
 * @triggeredBy tasks/create
 */
export const TaskFailedNotificationDefinition = defineNotification({
  name: "task/failed",
  params: TaskFailedNotificationSchema,
});

/**
 * Pushed when a task closes.
 * @triggeredBy tasks/close
 */
export const TaskClosedNotificationDefinition = defineNotification({
  name: "task/closed",
  params: TaskClosedNotificationSchema,
});

// ─────────────────────────────────────────────────────────────────────
// `task/*` + `task/conversation/*` — the task-scoped admin surface.
//
// A task is the unit of admission: every conversation under a task
// draws its participant pool from `task_participants`, and the task's
// owning app's TM (task manager) is the gatekeeper for membership
// changes.
//
// Layout:
//   - `task/create` / `task/leave` — task-level lifecycle.
//   - `task/conversation/*` — conversation lifecycle under a task.
//   - `task/conversation/participants/*` — membership inside a
//     specific conversation.
//
// Authority gates:
//
// | Method                                  | Authority                                |
// |-----------------------------------------|------------------------------------------|
// | TaskCreate                              | any authenticated agent + contact-policy |
// | TaskLeave                               | self only                                |
// | TaskConversationCreate                  | TM + participant-admitted invariant      |
// | TaskConversationList                    | self only (caller in conversation)       |
// | TaskConversationArchive / Unarchive     | TM only                                  |
// | TaskConversationAddParticipant          | TM + participant-admitted invariant      |
// | TaskConversationRemoveParticipant       | TM only                                  |
//
// Participant-admitted invariant (`TaskConversationCreate`,
// `TaskConversationAddParticipant`): every agent listed in
// `participants` MUST already appear in `task_participants` for
// `taskId`. Conversations are scoped strictly within their task's
// admission set; missing rows fail with `ParticipantNotAdmittedError`.
//
// Capability tags on the four TM-gated admin methods declare
// `TmAuthority` first so the lazy `provideServiceEffect` runs the TM
// check ahead of any participant probe. A non-TM caller sees
// `ForbiddenError` rather than leaking task-membership existence
// through `ParticipantNotAdmittedError`. The shared `argsOf` builders
// (`tmAuthorityArgsOfTask`, `conversationInTaskArgsOfPair`) keep the
// four descriptors' capability shapes from drifting.
//
// Atomicity: `task/create` with `initialConversation` commits the
// task row, then opens a separate transaction for the conversation
// insert. A conversation failure leaves the task row in place. Strict
// cross-call atomicity (single commit covering both rows) is not
// guaranteed.
//
// Notification emission: each mutating op enqueues notifications
// AFTER the row mutation returns. `task/create` with
// `initialConversation` emits one `task/conversation/created`.
// `task/leave` emits one
// `task/conversation/participants/removed { reason: "task_leave" }`
// per conversation the leaver was in, plus `task/closed` if the leave
// empties `task_participants`. Broadcast is best-effort: socket
// writes fork via `Effect.runFork` and do not roll back the DB write
// on delivery failure.
// ─────────────────────────────────────────────────────────────────────

const InitialConversationSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    participants: Type.Optional(Type.Array(AgentId, { minItems: 1 })),
  },
  { additionalProperties: false },
);

export type InitialConversationInput = Static<typeof InitialConversationSchema>;

/**
 * Spec D1 (#598) cardinality → label mapping for the legacy
 * `conversations.type` enum column. D1 retires the wire-level
 * `type: "dm" | "group"` field; the label is now derived from
 * participant cardinality (caller + targets totals 2 ⇒ `"dm"`,
 * otherwise `"group"`).
 *
 * Single source of truth so descriptor `argsOf` resolvers (which
 * build `ConversationCreateAuthorization` capability input
 * unconditionally per frame) cannot drift from the server-side
 * handler that calls `conversationService.create({ type, ... })`.
 * Both must agree because the type label is what the
 * `ConversationCreateAuthorization` obtain helper uses for
 * DM-existence dedup, contact-policy fan-out, and group-capacity
 * checks; a descriptor-vs-handler split would silently authorize
 * one path's type while persisting the other.
 *
 * Spec D3 (#600) deletes the `conversations.type` column entirely;
 * at that point this helper retires alongside.
 */
export function inferConversationType(
  participantAgentIds: ReadonlyArray<AgentId>,
): "dm" | "group" {
  return 1 + participantAgentIds.length === 2 ? "dm" : "group";
}

const TaskConversationListItemSchema = Type.Object(
  {
    taskId: TaskId,
    conversation: ConversationSchema,
    participants: Type.Array(AgentId),
  },
  { additionalProperties: false },
);

export type TaskConversationListItem = Static<
  typeof TaskConversationListItemSchema
>;

/**
 * Reshaped task-create: `appId` REQUIRED (branded), `tmType`
 * ELIMINATED at the wire, optional `initialConversation` for atomic
 * task + first-conversation creation.
 *
 * Dedup: when `appId === DEFAULT_APP_ID`, the server returns any
 * existing task whose `task_participants` set is exactly
 * `{callerAgentId} ∪ invitedAgentIds`. Single-invitee dedup
 * generalizes today's `conversationService.existingDmForCreate` (the
 * DM case is the `invitedAgentIds.length === 1` instance of the
 * same exact-participant-set match query).
 *
 * Returns `{ task, conversation }` where `conversation` is `null`
 * when `initialConversation` is omitted.
 */
export const TaskCreate = defineRpc({
  name: "task/create",
  params: Type.Object(
    {
      appId: AppId,
      invitedAgentIds: Type.Array(AgentId),
      initialConversation: Type.Optional(InitialConversationSchema),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      task: TaskSchema,
      conversation: Type.Union([ConversationSchema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
});

/**
 * Self-only: caller removes themselves from `task_participants` AND
 * every `conversation_participants` row under the task. See spec
 * body Goal 2 for the atomicity, idempotency, and
 * last-participant-task-closure contract.
 *
 * Notification emission for each conversation the caller leaves uses
 * `TaskConversationParticipantsRemovedNotificationDefinition` with
 * `reason: "task_leave"`. If removal empties `task_participants`
 * the task transitions to `status = 'closed'` and
 * `TaskClosedNotificationDefinition` fires alongside in the same
 * transaction.
 */
export const TaskLeave = defineRpc({
  name: "task/leave",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object({}, { additionalProperties: false }),
});

/**
 * TM-only: mint a new conversation under an existing task.
 * Renamed/reshaped from legacy `tasks/createConversation`. NEW
 * invariant: every entry in `participants` MUST already appear in
 * `task_participants` for `taskId`; violations return
 * `ParticipantNotAdmittedError`. Spec body Goal 1.
 *
 * Schema diff vs. legacy `TasksCreateConversation`:
 *   - removes `type: ConversationTypeEnum` (DM/Group collapse — D3
 *     retires the `conversation_type` enum column entirely)
 *   - participants typed as `AgentId[]` (was `agentParticipantRefSchema`)
 *     reflecting "agents only" — `tm:agent:*` shape is internal-only
 *     per spec body Non-goal 6
 */
export const TaskConversationCreate = defineRpc({
  name: "task/conversation/create",
  params: Type.Object(
    {
      taskId: TaskId,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      participants: Type.Array(AgentId, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { conversation: ConversationSchema },
    { additionalProperties: false },
  ),
  // Spec F #632 typed-dispatcher: declare in auth-first order. The
  // handler MUST also `yield* TmAuthority` before
  // `requireAgentsAreInTaskParticipants` runs (per per-flow doc
  // §"Capability list per new handler" + auth-first invariant) — the
  // dispatcher lazily provisions tags via `provideServiceEffect`, so a
  // tag that no body yields would never validate. `ConversationCreate-
  // Authorization` is consumed inside `conversationService.create`.
  capabilities: [
    {
      tag: TmAuthority,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return { taskId: p.taskId, callerAgentId: c.auth.agentId };
      },
    },
    {
      tag: ConversationCreateAuthorization,
      argsOf: (
        params: unknown,
        ctx: unknown,
      ): ObtainConversationCreateAuthorizationInput => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly participants: ReadonlyArray<AgentId>;
        };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return {
          // Spec D1 retires the wire `type` enum; `inferConversationType`
          // is the single source of truth shared with the server-side
          // `conversationService.create({ type, ... })` call so the
          // descriptor-provisioned obtain helper authorizes the same
          // label the handler persists.
          type: inferConversationType(p.participants),
          agentIds: [...p.participants],
          creatorAgentId: c.auth.agentId,
        };
      },
    },
  ] as const,
});

/**
 * Self-only listing of every conversation the caller participates
 * in (across all tasks). No filter params; archived rows are
 * included; callers filter `archivedAt` locally. See spec body
 * Goal 1 for the full pagination + visibility contract.
 */
export const TaskConversationList = defineRpc({
  name: "task/conversation/list",
  params: Type.Object(
    {
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      cursor: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      items: Type.Array(TaskConversationListItemSchema),
      nextCursor: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
});

// Shared `argsOf` builders for the four TM-and-conversation-in-task
// descriptors below — the four bodies use IDENTICAL capability arrays
// `[TmAuthority, ConversationInTask]`. Inline the shape locally (not
// exported) to keep the descriptor definitions terse and avoid
// drift between siblings.
const tmAuthorityArgsOfTask = (params: unknown, ctx: unknown) => {
  // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
  const p = params as { readonly taskId: TaskId };
  const c = ctx as { readonly auth: { readonly agentId: AgentId } };
  return { taskId: p.taskId, callerAgentId: c.auth.agentId };
};
const conversationInTaskArgsOfPair = (params: unknown) => {
  // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (Spec F §3 dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
  const p = params as {
    readonly taskId: TaskId;
    readonly conversationId: ConversationId;
  };
  return { taskId: p.taskId, conversationId: p.conversationId };
};

/** TM-only: archive one conversation. Task stays open. */
export const TaskConversationArchive = defineRpc({
  name: "task/conversation/archive",
  params: Type.Object(
    { taskId: TaskId, conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
  capabilities: [
    { tag: TmAuthority, argsOf: tmAuthorityArgsOfTask },
    { tag: ConversationInTask, argsOf: conversationInTaskArgsOfPair },
  ] as const,
});

/** TM-only: reverse of `task/conversation/archive`. */
export const TaskConversationUnarchive = defineRpc({
  name: "task/conversation/unarchive",
  params: Type.Object(
    { taskId: TaskId, conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
  capabilities: [
    { tag: TmAuthority, argsOf: tmAuthorityArgsOfTask },
    { tag: ConversationInTask, argsOf: conversationInTaskArgsOfPair },
  ] as const,
});

/**
 * TM-only: add an agent to one conversation. The agent MUST already
 * appear in `task_participants` for `taskId`; otherwise
 * `ParticipantNotAdmittedError`. Spec body Goal 1.
 */
export const TaskConversationAddParticipant = defineRpc({
  name: "task/conversation/participants/add",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
      agentId: AgentId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
  // Auth-first per per-flow doc §"Participant invariant" — the handler
  // also `yield* TmAuthority`s explicitly BEFORE
  // `requireAgentsAreInTaskParticipants` to force the obtain helper to
  // run early (lazy provideServiceEffect would otherwise defer it past
  // the participant-admitted probe).
  capabilities: [
    { tag: TmAuthority, argsOf: tmAuthorityArgsOfTask },
    { tag: ConversationInTask, argsOf: conversationInTaskArgsOfPair },
  ] as const,
});

/**
 * TM-only: remove an agent from one conversation. The agent stays
 * in `task_participants` (so they may still receive messages on
 * other conversations within the task).
 */
export const TaskConversationRemoveParticipant = defineRpc({
  name: "task/conversation/participants/remove",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
      agentId: AgentId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
  capabilities: [
    { tag: TmAuthority, argsOf: tmAuthorityArgsOfTask },
    { tag: ConversationInTask, argsOf: conversationInTaskArgsOfPair },
  ] as const,
});

// ─── task/conversation/* notifications ──────────────────────────────
//
// Five events (spec body Goal 5; the `task/conversation/updated`
// entry in the dispatch brief is stale relative to the spec body —
// `TaskConversationUpdate` is explicitly NOT included per Goal 1).
//
// Recipient fan-out (impl-staff target per docs/architecture/12):
//   - `created` → initial `participants` list
//   - `archived` / `unarchived` → post-mutation `conversation_participants`
//   - `participants/added` → post-mutation membership (newcomer included)
//   - `participants/removed` → pre-mutation membership (so the removed
//     agent still receives the notification)
// ────────────────────────────────────────────────────────────────────

const TaskConversationCreatedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    conversationId: ConversationId,
    name: Type.Optional(Type.String()),
    participants: Type.Array(AgentId),
  },
  { additionalProperties: false },
);

const TaskConversationArchivedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    conversationId: ConversationId,
    archivedAt: DateTimeString,
  },
  { additionalProperties: false },
);

const TaskConversationUnarchivedNotificationSchema = Type.Object(
  { taskId: TaskId, conversationId: ConversationId },
  { additionalProperties: false },
);

const TaskConversationParticipantsAddedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    conversationId: ConversationId,
    addedAgentId: AgentId,
    // Spec body Goal 5 declares this enum literal. Only `"tm"` for
    // now (D1 narrows authority to TM-only); D3 may widen.
    byAgentOrTm: stringEnum(["tm"]),
  },
  { additionalProperties: false },
);

const TaskConversationParticipantsRemovedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    conversationId: ConversationId,
    removedAgentId: AgentId,
    reason: stringEnum(["tm_remove", "task_leave"]),
  },
  { additionalProperties: false },
);

export type TaskConversationCreatedNotification = Static<
  typeof TaskConversationCreatedNotificationSchema
>;
export type TaskConversationArchivedNotification = Static<
  typeof TaskConversationArchivedNotificationSchema
>;
export type TaskConversationUnarchivedNotification = Static<
  typeof TaskConversationUnarchivedNotificationSchema
>;
export type TaskConversationParticipantsAddedNotification = Static<
  typeof TaskConversationParticipantsAddedNotificationSchema
>;
export type TaskConversationParticipantsRemovedNotification = Static<
  typeof TaskConversationParticipantsRemovedNotificationSchema
>;

export const TaskConversationCreatedNotificationDefinition = defineNotification(
  {
    name: "task/conversation/created",
    params: TaskConversationCreatedNotificationSchema,
  },
);

export const TaskConversationArchivedNotificationDefinition =
  defineNotification({
    name: "task/conversation/archived",
    params: TaskConversationArchivedNotificationSchema,
  });

export const TaskConversationUnarchivedNotificationDefinition =
  defineNotification({
    name: "task/conversation/unarchived",
    params: TaskConversationUnarchivedNotificationSchema,
  });

export const TaskConversationParticipantsAddedNotificationDefinition =
  defineNotification({
    name: "task/conversation/participants/added",
    params: TaskConversationParticipantsAddedNotificationSchema,
  });

export const TaskConversationParticipantsRemovedNotificationDefinition =
  defineNotification({
    name: "task/conversation/participants/removed",
    params: TaskConversationParticipantsRemovedNotificationSchema,
  });
