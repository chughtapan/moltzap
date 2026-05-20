import { Data } from "effect";
import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, dateTimeStringSchema } from "../schema-primitives.js";
import { AgentId } from "../identity/agents.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import {
  registerErrorClass,
  type RpcErrorPayload,
} from "../transport/wire-errors.js";
import { ConversationId, conversationSchema } from "./conversations.js";
import { AppId, TaskId } from "./ids.js";
// Direct per-file imports (NOT via the capabilities barrel) to keep the
// runtime dep graph one-way; see conversations.ts for the rationale.
import {
  ConversationCreateAuthorization,
  type ObtainConversationCreateAuthorizationInput,
} from "./capabilities/conversation-create-authorization.js";
import { ConversationInTask } from "./capabilities/conversation-in-task.js";
import { TmAuthority } from "./capabilities/tm-authority.js";

// `AppId` / `DEFAULT_APP_ID` / `TaskId` are defined in `./ids.ts` and
// re-exported here for backward compatibility of import paths.
export { AppId, DEFAULT_APP_ID, TaskId } from "./ids.js";

const DateTimeString = dateTimeStringSchema();
const ConversationSchema = conversationSchema();

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

export const TaskList = defineRpc({
  name: "task/list",
  params: Type.Object(
    {
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      cursor: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { tasks: Type.Array(TaskSchema) },
    { additionalProperties: false },
  ),
});

export const TaskClose = defineRpc({
  name: "task/close",
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

export const TaskAddParticipant = defineRpc({
  name: "task/addParticipant",
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

export const TaskRemoveParticipant = defineRpc({
  name: "task/removeParticipant",
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
// (`/safer:architect` per-flow doc §"Capability list per new
// handler" — see `packages/protocol/docs/architecture/task-conversation-family.md`).
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
 * Schema diff vs. legacy `tasks/createConversation`:
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
