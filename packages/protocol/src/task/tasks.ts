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
});

const TaskFailedNotificationSchema = Type.Object(
  { taskId: TaskId },
  { additionalProperties: false },
);

const TaskClosedNotificationSchema = Type.Object(
  { task: TaskSchema },
  { additionalProperties: false },
);

export const TaskFailedNotificationDefinition = defineNotification({
  name: "task/failed",
  params: TaskFailedNotificationSchema,
});

export const TaskClosedNotificationDefinition = defineNotification({
  name: "task/closed",
  params: TaskClosedNotificationSchema,
});

// ─────────────────────────────────────────────────────────────────────
// Spec D1 (#598) — additive `task/*` + `task/conversation/*` surface.
//
// These descriptors coexist with the legacy `tasks/*` and `conversations/*`
// families for the D1 transitional window. Spec D3 (#600) deletes the
// legacy descriptors and the parallel notification emission; this block
// becomes the only task-layer surface.
//
// Naming convention chosen by architect (resolves spec ambiguity):
//   - New methods use the singular `task/*` namespace to avoid wire
//     collisions with legacy `tasks/*` during dual-emit (`task/create`
//     vs. `tasks/create` are distinct wire names).
//   - Nested admin methods live under `task/conversation/*`.
//   - Participant operations sit under `task/conversation/participants/*`.
//
// Authority routing (impl-staff): all `Task*Authority`-gated admin
// methods (`task/conversation/{create,archive,unarchive,participants/*}`)
// MUST resolve via Spec E's `obtainTmAuthority(taskId, ctx.agentId)`
// once Spec E (#601) primitives land. `task/conversation/list` and
// `task/leave` resolve via self-auth (caller participation check).
// `task/create` is open to any authenticated agent subject to
// `requireContactPolicyForCreate` per `conversation.service.ts`
// (`/safer:architect` per-flow doc 12 §"Capability list per new
// handler" — see `packages/protocol/docs/architecture/12-task-conversation-family.md`).
// ─────────────────────────────────────────────────────────────────────

const InitialConversationSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    participants: Type.Optional(Type.Array(AgentId, { minItems: 1 })),
  },
  { additionalProperties: false },
);

export type InitialConversationInput = Static<typeof InitialConversationSchema>;

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

/** TM-only: archive one conversation. Task stays open. */
export const TaskConversationArchive = defineRpc({
  name: "task/conversation/archive",
  params: Type.Object(
    { taskId: TaskId, conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

/** TM-only: reverse of `task/conversation/archive`. */
export const TaskConversationUnarchive = defineRpc({
  name: "task/conversation/unarchive",
  params: Type.Object(
    { taskId: TaskId, conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
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
