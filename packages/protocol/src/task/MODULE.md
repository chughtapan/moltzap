# protocol/task

_`packages/protocol/src/task`_

## Purpose

Public barrel for task, conversation, message, and task-manager protocol descriptors.

## Public surface

### [`AppId`](./ids.ts#L7)

_TypeAlias_

```ts
export const AppId = brandedId("AppId");
```

### [`AppId`](./ids.ts#L7)

_Variable_

```ts
export const AppId = brandedId("AppId")
```

### [`Conversation`](./conversations.ts#L98)

_TypeAlias_

```ts
export type Conversation = Static<typeof ConversationSchema>;
```

### [`ConversationArchivedError`](./conversations.ts#L22)

_Class_

```ts
export class ConversationArchivedError extends Data.TaggedError(
  "ConversationArchived",
)<RpcErrorPayload> {
  static readonly code = -32022;
  static readonly message = "Conversation is archived";
}
```

### [`ConversationFullError`](./conversations.ts#L30)

_Class_

```ts
export class ConversationFullError extends Data.TaggedError(
  "ConversationFull",
)<RpcErrorPayload> {
  static readonly code = -32007;
  static readonly message = "Conversation is full";
}
```

### [`ConversationId`](./conversations.ts#L12)

_TypeAlias_

```ts
export const ConversationId = brandedId("ConversationId");
```

### [`ConversationId`](./conversations.ts#L12)

_Variable_

```ts
export const ConversationId = brandedId("ConversationId")
```

### [`ConversationParticipant`](./conversations.ts#L99)

_TypeAlias_

```ts
export type ConversationParticipant = Static<
  typeof ConversationParticipantSchema
>;
```

### [`conversationSchema`](./conversations.ts#L104)

_Function_

```ts
export function conversationSchema(): typeof ConversationSchema
```

### [`ConversationSummary`](./conversations.ts#L102)

_TypeAlias_

```ts
export type ConversationSummary = Static<typeof ConversationSummarySchema>;
```

### [`DEFAULT_APP_ID`](./ids.ts#L10)

_Variable_

```ts
export const DEFAULT_APP_ID = "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb" as AppId
```

### [`HookBlockedError`](./tasks.ts#L64)

_Class_

```ts
export class HookBlockedError extends Data.TaggedError(
  "HookBlocked",
)<RpcErrorPayload> {
  static readonly code = -32019;
  static readonly message = "Hook blocked the dispatch";
}
```

### [`InitialConversationInput`](./tasks.ts#L350)

_TypeAlias_

```ts
export type InitialConversationInput = Static<typeof InitialConversationSchema>;
```

### [`LeaseId`](./messages.ts#L9)

_TypeAlias_

```ts
export const LeaseId = brandedId("LeaseId");
```

### [`LeaseId`](./messages.ts#L9)

_Variable_

```ts
export const LeaseId = brandedId("LeaseId")
```

### [`LogicalClock`](./tasks.ts#L100)

_TypeAlias_

```ts
export type LogicalClock = Static<typeof LogicalClockSchema>;
```

### [`logicalClockSchema`](./tasks.ts#L102)

_Function_

```ts
export function logicalClockSchema(): typeof LogicalClockSchema
```

### [`Message`](./messages.ts#L75)

_TypeAlias_

```ts
export type Message = Static<typeof MessageSchema>;
```

### [`MessageId`](./conversations.ts#L19)

_TypeAlias_

```ts
export const MessageId = brandedId("MessageId");
```

### [`MessageId`](./conversations.ts#L19)

_Variable_

```ts
export const MessageId = brandedId("MessageId")
```

### [`messagePartsSchema`](./messages.ts#L84)

_Function_

```ts
export function messagePartsSchema(): typeof MessagePartsSchema
```

### [`MessageReceivedNotification`](./messages.ts#L272)

_TypeAlias_

```ts
export type MessageReceivedNotification = Static<
  typeof MessageReceivedNotificationSchema
>;
```

### [`MessageReceivedNotificationDefinition`](./messages.ts#L280)

_Variable_

```ts
export const MessageReceivedNotificationDefinition = defineNotification({
  name: "messages/received",
  params: MessageReceivedNotificationSchema,
})
```

Pushed when a new message is delivered to your WebSocket connection.

### [`MessagesList`](./messages.ts#L221)

_Variable_

```ts
export const MessagesList = defineRpc({
  name: "messages/list",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
      sinceSeq: Type.Optional(
        Type.String({
          description: "Snowflake seq cursor (string-encoded BIGINT)",
        }),
      ),
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
})
```

List messages in a conversation with cursor-based pagination using sequence numbers.

### [`MessagesSend`](./messages.ts#L162)

_Variable_

```ts
export const MessagesSend = defineRpc({
  name: "messages/send",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
      parts: MessagePartsSchema,
      replyToId: Type.Optional(MessageId),
      dispatchLeaseId: Type.Optional(LeaseId),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { message: MessageSchema },
    { additionalProperties: false },
  ),
  capabilities: [
    {
      tag: ConversationInTask,
      argsOf: (params: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly taskId: TaskId;
          readonly conversationId: ConversationId;
        };
        return { taskId: p.taskId, conversationId: p.conversationId };
      },
    },
    {
      tag: MessageSendPermission,
      argsOf: (
        params: unknown,
        ctx: unknown,
      ): ObtainMessageSendPermissionInput => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly taskId: TaskId;
          readonly conversationId: ConversationId;
          readonly replyToId?: Static<typeof MessageId>;
        };
        const c = ctx as {
          readonly auth: { readonly agentId: AgentId };
        };
        return {
          taskId: p.taskId,
          conversationId: p.conversationId,
          senderAgentId: c.auth.agentId,
          replyToId: p.replyToId,
        };
      },
    },
  ] as const,
})
```

Send a message to a conversation under a task. Both `taskId` and
`conversationId` are required; the conversation must already exist
(created via `task/conversation/create`) and the sender must be a
participant.

**Returns:** The created message with ID, sequence number, and timestamp.

### [`MessageWithTmDecision`](./messages.ts#L141)

_TypeAlias_

```ts
export type MessageWithTmDecision = Static<typeof MessageWithTmDecisionSchema>;
```

### [`messageWithTmDecisionSchema`](./messages.ts#L147)

_Function_

```ts
export function messageWithTmDecisionSchema(): typeof MessageWithTmDecisionSchema
```

### [`nonTmAuthorityTaskRpcMethods`](./methods.ts#L49)

_Variable_

```ts
export const nonTmAuthorityTaskRpcMethods = [
  TaskRequest,
  TaskList,
  TaskLeave,
  MessagesSend,
  MessagesList,
] as const
```

### [`Part`](./messages.ts#L54)

_TypeAlias_

```ts
export type Part = Static<typeof PartSchema>;
```

### [`ParticipantNotAdmittedError`](./tasks.ts#L79)

_Class_

```ts
export class ParticipantNotAdmittedError extends Data.TaggedError(
  "ParticipantNotAdmitted",
)<RpcErrorPayload> {
  static readonly code = -32023;
  static readonly message = "Agent is not admitted to the task";
}
```

`task/conversation/create` and `task/conversation/participants/add`
reject agents who are not already in `task_participants`. The error
tag lets clients distinguish "wrong agentId shape" (InvalidParams)
from "agent exists but is not admitted to this task" (this tag)
without parsing message strings.

### [`Task`](./tasks.ts#L124)

_TypeAlias_

```ts
export type Task = Static<typeof TaskSchema>;
```

### [`TaskAddParticipant`](./tasks.ts#L178)

_Variable_

```ts
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
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as CallerConnIdCtx;
        return {
          taskId: p.taskId,
          callerConnId: c.connection.id,
        };
      },
    },
  ] as const,
})
```

### [`TaskClose`](./tasks.ts#L158)

_Variable_

```ts
export const TaskClose = defineRpc({
  name: "task/close",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object({ task: TaskSchema }, { additionalProperties: false }),
  capabilities: [
    {
      tag: TmAuthority,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as CallerConnIdCtx;
        return {
          taskId: p.taskId,
          callerConnId: c.connection.id,
        };
      },
    },
  ] as const,
})
```

### [`TaskClosedError`](./tasks.ts#L39)

_Class_

```ts
export class TaskClosedError extends Data.TaggedError(
  "TaskClosed",
)<RpcErrorPayload> {
  static readonly code = -32020;
  static readonly message = "Task is closed";
}
```

### [`TaskClosedNotificationDefinition`](./tasks.ts#L280)

_Variable_

```ts
export const TaskClosedNotificationDefinition = defineNotification({
  name: "task/closed",
  params: TaskClosedNotificationSchema,
})
```

Pushed when a task closes.

### [`TaskConversationAddParticipant`](./tasks.ts#L581)

_Variable_

```ts
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
})
```

TM-only: add an agent to one conversation. The agent MUST already
appear in `task_participants` for `taskId`; otherwise
`ParticipantNotAdmittedError`. Spec body Goal 1.

### [`TaskConversationArchive`](./tasks.ts#L549)

_Variable_

```ts
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
})
```

TM-only: archive one conversation. Task stays open.

### [`TaskConversationArchivedNotification`](./tasks.ts#L688)

_TypeAlias_

```ts
export type TaskConversationArchivedNotification = Static<
  typeof TaskConversationArchivedNotificationSchema
>;
```

### [`TaskConversationArchivedNotificationDefinition`](./tasks.ts#L708)

_Variable_

```ts
export const TaskConversationArchivedNotificationDefinition =
  defineNotification({
    name: "task/conversation/archived",
    params: TaskConversationArchivedNotificationSchema,
  })
```

### [`TaskConversationCreate`](./tasks.ts#L449)

_Variable_

```ts
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
  // Tags are declared in auth-first order. The handler must explicitly
  // `yield* TmAuthority` before `requireAgentsAreInTaskParticipants` —
  // the dispatcher provisions tags lazily, so a non-TM caller would
  // otherwise see `ParticipantNotAdmittedError` (a state probe) instead
  // of `ForbiddenError`.
  capabilities: [
    {
      tag: TmAuthority,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as CallerConnIdCtx;
        return {
          taskId: p.taskId,
          callerConnId: c.connection.id,
        };
      },
    },
    {
      tag: ConversationCreateAuthorization,
      argsOf: (
        params: unknown,
        ctx: unknown,
      ): ObtainConversationCreateAuthorizationInput => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly participants: ReadonlyArray<AgentId>;
        };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return {
          agentIds: [...p.participants],
          creatorAgentId: c.auth.agentId,
        };
      },
    },
  ] as const,
})
```

TM-only: mint a new conversation under an existing task. Every
entry in `participants` MUST already appear in `task_participants`
for `taskId`; violations return `ParticipantNotAdmittedError`.

### [`TaskConversationCreatedNotification`](./tasks.ts#L685)

_TypeAlias_

```ts
export type TaskConversationCreatedNotification = Static<
  typeof TaskConversationCreatedNotificationSchema
>;
```

### [`TaskConversationCreatedNotificationDefinition`](./tasks.ts#L701)

_Variable_

```ts
export const TaskConversationCreatedNotificationDefinition = defineNotification(
  {
    name: "task/conversation/created",
    params: TaskConversationCreatedNotificationSchema,
  },
)
```

### [`TaskConversationList`](./tasks.ts#L507)

_Variable_

```ts
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
})
```

Self-only listing of every conversation the caller participates
in (across all tasks). No filter params; archived rows are
included; callers filter `archivedAt` locally. See spec body
Goal 1 for the full pagination + visibility contract.

### [`TaskConversationListItem`](./tasks.ts#L361)

_TypeAlias_

```ts
export type TaskConversationListItem = Static<
  typeof TaskConversationListItemSchema
>;
```

### [`TaskConversationParticipantsAddedNotification`](./tasks.ts#L694)

_TypeAlias_

```ts
export type TaskConversationParticipantsAddedNotification = Static<
  typeof TaskConversationParticipantsAddedNotificationSchema
>;
```

### [`TaskConversationParticipantsAddedNotificationDefinition`](./tasks.ts#L720)

_Variable_

```ts
export const TaskConversationParticipantsAddedNotificationDefinition =
  defineNotification({
    name: "task/conversation/participants/added",
    params: TaskConversationParticipantsAddedNotificationSchema,
  })
```

### [`TaskConversationParticipantsRemovedNotification`](./tasks.ts#L697)

_TypeAlias_

```ts
export type TaskConversationParticipantsRemovedNotification = Static<
  typeof TaskConversationParticipantsRemovedNotificationSchema
>;
```

### [`TaskConversationParticipantsRemovedNotificationDefinition`](./tasks.ts#L726)

_Variable_

```ts
export const TaskConversationParticipantsRemovedNotificationDefinition =
  defineNotification({
    name: "task/conversation/participants/removed",
    params: TaskConversationParticipantsRemovedNotificationSchema,
  })
```

### [`TaskConversationRemoveParticipant`](./tasks.ts#L608)

_Variable_

```ts
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
})
```

TM-only: remove an agent from one conversation. The agent stays
in `task_participants` (so they may still receive messages on
other conversations within the task).

### [`TaskConversationUnarchive`](./tasks.ts#L563)

_Variable_

```ts
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
})
```

TM-only: reverse of `task/conversation/archive`.

### [`TaskConversationUnarchivedNotification`](./tasks.ts#L691)

_TypeAlias_

```ts
export type TaskConversationUnarchivedNotification = Static<
  typeof TaskConversationUnarchivedNotificationSchema
>;
```

### [`TaskConversationUnarchivedNotificationDefinition`](./tasks.ts#L714)

_Variable_

```ts
export const TaskConversationUnarchivedNotificationDefinition =
  defineNotification({
    name: "task/conversation/unarchived",
    params: TaskConversationUnarchivedNotificationSchema,
  })
```

### [`TaskCreatedNotificationDefinition`](./tasks.ts#L271)

_Variable_

```ts
export const TaskCreatedNotificationDefinition = defineNotification({
  name: "task/created",
  params: TaskCreatedNotificationSchema,
})
```

Pushed to the task initiator + invited participants after the TM
accepts via the `task/create` wire callback and the task
transitions from `waiting` to `active`. Carries the full Task row
(matching `task/closed`'s shape) so subscribers don't need a
second read to discover the post-transition state.

### [`TaskFailedNotificationDefinition`](./tasks.ts#L259)

_Variable_

```ts
export const TaskFailedNotificationDefinition = defineNotification({
  name: "task/failed",
  params: TaskFailedNotificationSchema,
})
```

Pushed when a task fails before becoming ready.

### [`TaskId`](./ids.ts#L4)

_TypeAlias_

```ts
export const TaskId = brandedId("TaskId");
```

### [`TaskId`](./ids.ts#L4)

_Variable_

```ts
export const TaskId = brandedId("TaskId")
```

### [`TaskLeave`](./tasks.ts#L438)

_Variable_

```ts
export const TaskLeave = defineRpc({
  name: "task/leave",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object({}, { additionalProperties: false }),
})
```

Self-only: caller removes themselves from `task_participants` AND
every `conversation_participants` row under the task. See spec
body Goal 2 for the atomicity, idempotency, and
last-participant-task-closure contract.

Notification emission for each conversation the caller leaves uses
`TaskConversationParticipantsRemovedNotificationDefinition` with
`reason: "task_leave"`. If removal empties `task_participants`
the task transitions to `status = 'closed'` and
`TaskClosedNotificationDefinition` fires alongside in the same
transaction.

### [`TaskList`](./tasks.ts#L143)

_Variable_

```ts
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
})
```

### [`taskNotifications`](./methods.ts#L68)

_Variable_

```ts
export const taskNotifications = [
  MessageReceivedNotificationDefinition,
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  // Spec D3 canonical: only the task/conversation/* set survives the
  // `conversations/*` notification deletion.
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
] as const
```

### [`TaskParticipant`](./tasks.ts#L141)

_TypeAlias_

```ts
export type TaskParticipant = Static<typeof TaskParticipantSchema>;
```

### [`TaskRejectedError`](./tasks.ts#L56)

_Class_

```ts
export class TaskRejectedError extends Data.TaggedError(
  "TaskRejected",
)<RpcErrorPayload> {
  static readonly code = -32024;
  static readonly message = "Task request was rejected by the task manager";
}
```

`task/request` failed because the bound TM rejected the
server-initiated `task/create` callback (or the fail-closed
envelope synthesized a reject on timeout / RPC error / decode
failure). The tag lets a requester distinguish "my task was
rejected by the moderator" — an expected, actionable outcome —
from an opaque internal error. The TM's reason rides in the
`data` arm when present.

### [`TaskRemoveParticipant`](./tasks.ts#L207)

_Variable_

```ts
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
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as { readonly taskId: TaskId };
        const c = ctx as CallerConnIdCtx;
        return {
          taskId: p.taskId,
          callerConnId: c.connection.id,
        };
      },
    },
  ] as const,
})
```

### [`TaskRequest`](./tasks.ts#L384)

_Variable_

```ts
export const TaskRequest = defineRpc({
  name: "task/request",
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
  // Contact-policy gate. The dispatcher auto-provisions this before the
  // app-layer handler runs; the handler drains it as a precondition of
  // creating the task. Empty `invitedAgentIds` provisions a no-op proof
  // (zero targets short-circuit the obtain helper). The descriptor
  // declares the gate so the wire surface reflects the authorization
  // need even though `task/request` is bound via `defineAppMethod`.
  capabilities: [
    {
      tag: ContactPolicyAllowsReach,
      argsOf: (params: unknown, ctx: unknown) => {
        // #ignore-sloppy-code-next-line[params-cast]: descriptor argsOf re-imposes per-method param type (dispatcher-boundary erasure carve-out — params arrives as `unknown` from the type-erased dispatcher)
        const p = params as {
          readonly invitedAgentIds: ReadonlyArray<AgentId>;
        };
        const c = ctx as { readonly auth: { readonly agentId: AgentId } };
        return {
          creatorAgentId: c.auth.agentId,
          targetAgentIds: [...p.invitedAgentIds],
        };
      },
    },
  ] as const,
})
```

Open to any authenticated agent. Returns `{ task, conversation }`
where `conversation` is `null` when `initialConversation` is omitted.

Dedup is a client-side concern: clients that want "one DM per
participant set" semantics list their tasks and filter locally
before creating a new one.

NOTE (#683): the agent-facing entry RPC is `task/request`; the
TM-facing wire callback `task/create` lives in
`packages/protocol/src/app/methods.ts`. The server forks
`task/create` to the bound TM after inserting the task in
`waiting`; the TM's verdict drives the lifecycle (accept → active
+ `task/created`; reject → failed + `task/failed`). The synchronous
`{ task, conversation }` result is returned after the verdict
resolves (the handler awaits it). A future ack-then-notify variant
could return `{ taskId }` immediately and let `task/created` /
`task/failed` carry the outcome; that is not the current shape.

### [`taskRpcMethods`](./methods.ts#L31)

_Variable_

```ts
export const taskRpcMethods = [
  MessagesSend,
  MessagesList,
  TaskRequest,
  TaskLeave,
  TaskList,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
] as const
```

### [`TaskStatus`](./tasks.ts#L109)

_TypeAlias_

```ts
export type TaskStatus = Static<typeof TaskStatusEnum>;
```

### [`TmDecision`](./messages.ts#L128)

_TypeAlias_

```ts
export type TmDecision = Static<typeof TmDecisionSchema>;
```

### [`tmDecisionSchema`](./messages.ts#L143)

_Function_

```ts
export function tmDecisionSchema(): typeof TmDecisionSchema
```

### [`tmOnlyTaskRpcMethods`](./methods.ts#L57)

_Variable_

```ts
export const tmOnlyTaskRpcMethods = [
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  TaskConversationCreate,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
] as const
```

### [`validateMessage`](./messages.ts#L80)

_Variable_

```ts
export const validateMessage = ajv.compile(MessageSchema) as (
  value: unknown,
)
```

### [`validateTextPart`](./messages.ts#L77)

_Variable_

```ts
export const validateTextPart = ajv.compile(TextPartSchema) as (
  value: unknown,
)
```

### [`validateTmDecision`](./messages.ts#L129)

_Variable_

```ts
export const validateTmDecision = ajv.compile(TmDecisionSchema) as (
  value: unknown,
)
```

## Files

- `conversations.ts`
- `ids.ts`
- `messages.ts`
- `methods.ts`
- `tasks.ts`
