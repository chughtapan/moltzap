# protocol/task

_`packages/protocol/src/task`_

## Purpose

Public barrel for task, conversation, message, and task-manager protocol descriptors.

## Public surface

### [`agentCallableTaskRpcMethods`](./methods.ts#L50)

_Variable_

```ts
export const agentCallableTaskRpcMethods = [
  TaskRequest,
  TaskList,
  TaskLeave,
  MessagesSend,
  MessagesList,
] as const
```

### [`appCallableTaskRpcMethods`](./methods.ts#L58)

_Variable_

```ts
export const appCallableTaskRpcMethods = [
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

### [`Conversation`](./conversations.ts#L104)

_TypeAlias_

```ts
export type Conversation = Schema.Schema.Type<typeof ConversationSchema>;
```

### [`ConversationArchivedError`](./conversations.ts#L43)

_Class_

```ts
export class ConversationArchivedError extends Schema.TaggedError<ConversationArchivedError>()(
  "ConversationArchived",
  errorPayloadFields,
) {
  static readonly message = "Conversation is archived";
}
```

### [`ConversationFullError`](./conversations.ts#L50)

_Class_

```ts
export class ConversationFullError extends Schema.TaggedError<ConversationFullError>()(
  "ConversationFull",
  errorPayloadFields,
) {
  static readonly message = "Conversation is full";
}
```

### [`ConversationId`](./conversations.ts#L17)

_TypeAlias_

```ts
export const ConversationId = brandedId("ConversationId");
```

### [`ConversationId`](./conversations.ts#L17)

_Variable_

```ts
export const ConversationId = brandedId("ConversationId")
```

### [`ConversationNotFoundError`](./conversations.ts#L28)

_Class_

```ts
export class ConversationNotFoundError extends Schema.TaggedError<ConversationNotFoundError>()(
  "ConversationNotFound",
  errorPayloadFields,
) {
  static readonly message = "Conversation not found";
}
```

The referenced conversation does not exist under the task (or is not visible).

### [`ConversationParticipant`](./conversations.ts#L105)

_TypeAlias_

```ts
export type ConversationParticipant = Schema.Schema.Type<
  typeof ConversationParticipantSchema
>;
```

### [`conversationSchema`](./conversations.ts#L112)

_Function_

```ts
export function conversationSchema(): typeof ConversationSchema
```

### [`ConversationSummary`](./conversations.ts#L108)

_TypeAlias_

```ts
export type ConversationSummary = Schema.Schema.Type<
  typeof ConversationSummarySchema
>;
```

### [`DEFAULT_APP_ID`](./ids.ts#L10)

_Variable_

```ts
export const DEFAULT_APP_ID = "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb" as AppId
```

### [`DispatchDecision`](./messages.ts#L134)

_TypeAlias_

```ts
export type DispatchDecision = Schema.Schema.Type<
  typeof DispatchDecisionSchema
>;
```

### [`dispatchDecisionSchema`](./messages.ts#L151)

_Function_

```ts
export function dispatchDecisionSchema(): typeof DispatchDecisionSchema
```

### [`HookBlockedError`](./tasks.ts#L74)

_Class_

```ts
export class HookBlockedError extends Schema.TaggedError<HookBlockedError>()(
  "HookBlocked",
  errorPayloadFields,
) {
  static readonly message = "Hook blocked the dispatch";
}
```

### [`InitialConversationInput`](./tasks.ts#L305)

_TypeAlias_

```ts
export type InitialConversationInput = Schema.Schema.Type<
  typeof InitialConversationSchema
>;
```

### [`LeaseId`](./messages.ts#L21)

_TypeAlias_

```ts
export const LeaseId = brandedId("LeaseId");
```

### [`LeaseId`](./messages.ts#L21)

_Variable_

```ts
export const LeaseId = brandedId("LeaseId")
```

### [`LogicalClock`](./tasks.ts#L108)

_TypeAlias_

```ts
export type LogicalClock = Schema.Schema.Type<typeof LogicalClockSchema>;
```

### [`logicalClockSchema`](./tasks.ts#L110)

_Function_

```ts
export function logicalClockSchema(): typeof LogicalClockSchema
```

### [`Message`](./messages.ts#L79)

_TypeAlias_

```ts
export type Message = Schema.Schema.Type<typeof MessageSchema>;
```

### [`MessageId`](./conversations.ts#L24)

_TypeAlias_

```ts
export const MessageId = brandedId("MessageId");
```

### [`MessageId`](./conversations.ts#L24)

_Variable_

```ts
export const MessageId = brandedId("MessageId")
```

### [`messagePartsSchema`](./messages.ts#L99)

_Function_

```ts
export function messagePartsSchema(): typeof MessagePartsSchema
```

### [`MessageReceivedNotification`](./messages.ts#L242)

_TypeAlias_

```ts
export type MessageReceivedNotification = Schema.Schema.Type<
  typeof MessageReceivedNotificationSchema
>;
```

### [`MessageReceivedNotificationDefinition`](./messages.ts#L250)

_Variable_

```ts
export const MessageReceivedNotificationDefinition = defineNotification({
  name: "messages/received",
  params: MessageReceivedNotificationSchema,
})
```

Pushed when a new message is delivered to your WebSocket connection.

### [`MessagesList`](./messages.ts#L213)

_Variable_

```ts
export const MessagesList = defineRpc({
  name: "messages/list",
  params: Schema.Struct({
    taskId: TaskId,
    conversationId: ConversationId,
    sinceSeq: Schema.optional(
      Schema.String.annotations({
        description: "Snowflake seq cursor (string-encoded BIGINT)",
      }),
    ),
    limit: ListLimitSchema,
  }),
  result: Schema.Struct({
    messages: Schema.Array(MessageSchema),
    hasMore: Schema.Boolean,
  }),
  callablePrincipal: "agent",
  requiresActive: true,
  // Run order: `TaskReadAccess` proves the caller may read the task before
  // `ConversationInTask` resolves the conversation's task membership.
  caps: [TaskReadAccess, ConversationInTask],
  errors: [],
})
```

List messages in a conversation with cursor-based pagination using sequence numbers.
Conversation-not-found and not-a-participant ride the `TaskReadAccess` /
`ConversationInTask` cap error channels.

### [`MessagesSend`](./messages.ts#L170)

_Variable_

```ts
export const MessagesSend = defineRpc({
  name: "messages/send",
  params: Schema.Struct({
    taskId: TaskId,
    conversationId: ConversationId,
    parts: MessagePartsSchema,
    replyToId: Schema.optional(MessageId),
    dispatchLeaseId: Schema.optional(LeaseId),
  }),
  result: Schema.Struct({ message: MessageSchema }),
  callablePrincipal: "agent",
  requiresActive: true,
  // Two stacked cap middlewares form the send authorization spine:
  // `ConversationInTask` resolves the conversation's task membership;
  // `ConversationSendAccess` proves participation and does the ONE joined
  // (`conversations ⋈ tasks`) read, providing the row to the handler. The
  // remaining send preconditions — task-active, conversation-not-archived,
  // reply-target — are handler-body guards that refine that provided row (they
  // share the one read; `@effect/rpc` middlewares cannot read each other's
  // provided value, so a refinement that depends on the row is a handler guard,
  // not a standalone middleware).
  caps: [ConversationInTask, ConversationSendAccess],
  // Handler-domain errors, including the send-guard failures (`TaskClosed`,
  // `ConversationArchived`, reply-target `NotFound`) that the handler raises
  // while refining the `ConversationSendAccess` row. `ForbiddenError`/
  // `NotFoundError` also ride the dispatch-lease claim path: a consumed/invalid
  // lease maps to `ForbiddenError(data.reason: "LeaseInvalid")`, a missing lease
  // to `NotFoundError`. The principal-gate + cap-middleware errors come from
  // their middlewares.
  errors: [
    HookBlockedError,
    ForbiddenError,
    NotFoundError,
    TaskClosedError,
    ConversationArchivedError,
  ],
})
```

Send a message to a conversation under a task. Both `taskId` and
`conversationId` are required; the conversation must already exist
(created via `task/conversation/create`) and the sender must be a
participant.

**Returns:** The created message with ID, sequence number, and timestamp.

### [`MessageWithDispatchDecision`](./messages.ts#L147)

_TypeAlias_

```ts
export type MessageWithDispatchDecision = Schema.Schema.Type<
  typeof MessageWithDispatchDecisionSchema
>;
```

### [`messageWithDispatchDecisionSchema`](./messages.ts#L155)

_Function_

```ts
export function messageWithDispatchDecisionSchema(): typeof MessageWithDispatchDecisionSchema
```

### [`NotAParticipantError`](./conversations.ts#L36)

_Class_

```ts
export class NotAParticipantError extends Schema.TaggedError<NotAParticipantError>()(
  "NotAParticipant",
  errorPayloadFields,
) {
  static readonly message = "Not a participant in the conversation";
}
```

The caller is not a participant in the conversation it is acting on.

### [`Part`](./messages.ts#L61)

_TypeAlias_

```ts
export type Part = Schema.Schema.Type<typeof PartSchema>;
```

### [`ParticipantNotAdmittedError`](./tasks.ts#L88)

_Class_

```ts
export class ParticipantNotAdmittedError extends Schema.TaggedError<ParticipantNotAdmittedError>()(
  "ParticipantNotAdmitted",
  errorPayloadFields,
) {
  static readonly message = "Agent is not admitted to the task";
}
```

`task/conversation/create` and `task/conversation/participants/add`
reject agents who are not already in `task_participants`. The error
tag lets clients distinguish "wrong agentId shape" (InvalidParams)
from "agent exists but is not admitted to this task" (this tag)
without parsing message strings.

### [`Task`](./tasks.ts#L129)

_TypeAlias_

```ts
export type Task = Schema.Schema.Type<typeof TaskSchema>;
```

### [`TaskAddParticipant`](./tasks.ts#L169)

_Variable_

```ts
export const TaskAddParticipant = defineRpc({
  name: "task/addParticipant",
  params: Schema.Struct({
    taskId: TaskId,
    agentId: AgentId,
  }),
  result: Schema.Struct({ participant: TaskParticipantSchema }),
  callablePrincipal: "app",
  // `ForbiddenError`: the app-arm handler runs `assertCallerAppOwnsTask`
  // before the body, rejecting a caller that does not own the task.
  errors: [ForbiddenError, TaskNotFoundError],
})
```

### [`TaskClose`](./tasks.ts#L159)

_Variable_

```ts
export const TaskClose = defineRpc({
  name: "task/close",
  params: Schema.Struct({ taskId: TaskId }),
  result: Schema.Struct({ task: TaskSchema }),
  callablePrincipal: "app",
  // `ForbiddenError`: the app-arm handler runs `assertCallerAppOwnsTask`
  // before the body, rejecting a caller that does not own the task.
  errors: [ForbiddenError, TaskNotFoundError],
})
```

### [`TaskClosedError`](./tasks.ts#L51)

_Class_

```ts
export class TaskClosedError extends Schema.TaggedError<TaskClosedError>()(
  "TaskClosed",
  errorPayloadFields,
) {
  static readonly message = "Task is closed";
}
```

### [`TaskClosedNotificationDefinition`](./tasks.ts#L235)

_Variable_

```ts
export const TaskClosedNotificationDefinition = defineNotification({
  name: "task/closed",
  params: TaskClosedNotificationSchema,
})
```

Pushed when a task closes.

### [`TaskConversationAddParticipant`](./tasks.ts#L463)

_Variable_

```ts
export const TaskConversationAddParticipant = defineRpc({
  name: "task/conversation/participants/add",
  params: Schema.Struct({
    taskId: TaskId,
    conversationId: ConversationId,
    agentId: AgentId,
  }),
  result: Schema.Struct({}),
  callablePrincipal: "app",
  // App-ownership is gated by the app-arm handler's `assertCallerAppOwnsTask`
  // BEFORE `requireAgentsAreInTaskParticipants` (so a non-owner sees
  // `ForbiddenError`, not the participant-admitted state probe).
  caps: [ConversationInTask],
  errors: [ForbiddenError, ParticipantNotAdmittedError],
})
```

TM-only: add an agent to one conversation. The agent MUST already
appear in `task_participants` for `taskId`; otherwise
`ParticipantNotAdmittedError`. Spec body Goal 1.

### [`TaskConversationArchive`](./tasks.ts#L435)

_Variable_

```ts
export const TaskConversationArchive = defineRpc({
  name: "task/conversation/archive",
  params: Schema.Struct({ taskId: TaskId, conversationId: ConversationId }),
  result: Schema.Struct({}),
  callablePrincipal: "app",
  caps: [ConversationInTask],
  // `ForbiddenError`: the app-arm handler runs `assertCallerAppOwnsTask`
  // before the body, rejecting a caller that does not own the task.
  errors: [ForbiddenError],
})
```

TM-only: archive one conversation. Task stays open.

### [`TaskConversationArchivedNotification`](./tasks.ts#L547)

_TypeAlias_

```ts
export type TaskConversationArchivedNotification = Schema.Schema.Type<
  typeof TaskConversationArchivedNotificationSchema
>;
```

### [`TaskConversationArchivedNotificationDefinition`](./tasks.ts#L568)

_Variable_

```ts
export const TaskConversationArchivedNotificationDefinition =
  defineNotification({
    name: "task/conversation/archived",
    params: TaskConversationArchivedNotificationSchema,
  })
```

### [`TaskConversationCreate`](./tasks.ts#L382)

_Variable_

```ts
export const TaskConversationCreate = defineRpc({
  name: "task/conversation/create",
  params: Schema.Struct({
    taskId: TaskId,
    name: Schema.optional(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
    ),
    participants: Schema.Array(AgentId).pipe(Schema.minItems(1)),
  }),
  result: Schema.Struct({ conversation: ConversationSchema }),
  callablePrincipal: "app",
  // No caps. App-ownership is gated by the app-arm handler's
  // `assertCallerAppOwnsTask` (raising `ForbiddenError` for a non-owner before
  // the body); `ConversationCreateAuthorization` is provided inline by the
  // handler as a capacity-only proof (a TM minting on the task's behalf has no
  // agent contact-edges; targets are gated by
  // `requireAgentsAreInTaskParticipants`).
  errors: [
    ForbiddenError,
    TaskNotFoundError,
    ParticipantNotAdmittedError,
    ConversationFullError,
  ],
})
```

TM-only: mint a new conversation under an existing task. Every
entry in `participants` MUST already appear in `task_participants`
for `taskId`; violations return `ParticipantNotAdmittedError`.

### [`TaskConversationCreatedNotification`](./tasks.ts#L544)

_TypeAlias_

```ts
export type TaskConversationCreatedNotification = Schema.Schema.Type<
  typeof TaskConversationCreatedNotificationSchema
>;
```

### [`TaskConversationCreatedNotificationDefinition`](./tasks.ts#L561)

_Variable_

```ts
export const TaskConversationCreatedNotificationDefinition = defineNotification(
  {
    name: "task/conversation/created",
    params: TaskConversationCreatedNotificationSchema,
  },
)
```

### [`TaskConversationList`](./tasks.ts#L413)

_Variable_

```ts
export const TaskConversationList = defineRpc({
  name: "task/conversation/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({
    items: Schema.Array(TaskConversationListItemSchema),
    nextCursor: Schema.optional(Schema.String),
  }),
  callablePrincipal: "agent",
  requiresActive: true,
  errors: [],
})
```

Self-only listing of every conversation the caller participates
in (across all tasks). No filter params; archived rows are
included; callers filter `archivedAt` locally. See spec body
Goal 1 for the full pagination + visibility contract.

### [`TaskConversationListItem`](./tasks.ts#L315)

_TypeAlias_

```ts
export type TaskConversationListItem = Schema.Schema.Type<
  typeof TaskConversationListItemSchema
>;
```

### [`TaskConversationParticipantsAddedNotification`](./tasks.ts#L553)

_TypeAlias_

```ts
export type TaskConversationParticipantsAddedNotification = Schema.Schema.Type<
  typeof TaskConversationParticipantsAddedNotificationSchema
>;
```

### [`TaskConversationParticipantsAddedNotificationDefinition`](./tasks.ts#L580)

_Variable_

```ts
export const TaskConversationParticipantsAddedNotificationDefinition =
  defineNotification({
    name: "task/conversation/participants/added",
    params: TaskConversationParticipantsAddedNotificationSchema,
  })
```

### [`TaskConversationParticipantsRemovedNotification`](./tasks.ts#L556)

_TypeAlias_

```ts
export type TaskConversationParticipantsRemovedNotification =
  Schema.Schema.Type<
    typeof TaskConversationParticipantsRemovedNotificationSchema
  >;
```

### [`TaskConversationParticipantsRemovedNotificationDefinition`](./tasks.ts#L586)

_Variable_

```ts
export const TaskConversationParticipantsRemovedNotificationDefinition =
  defineNotification({
    name: "task/conversation/participants/removed",
    params: TaskConversationParticipantsRemovedNotificationSchema,
  })
```

### [`TaskConversationRemoveParticipant`](./tasks.ts#L484)

_Variable_

```ts
export const TaskConversationRemoveParticipant = defineRpc({
  name: "task/conversation/participants/remove",
  params: Schema.Struct({
    taskId: TaskId,
    conversationId: ConversationId,
    agentId: AgentId,
  }),
  result: Schema.Struct({}),
  callablePrincipal: "app",
  caps: [ConversationInTask],
  // `ForbiddenError`: the app-arm handler runs `assertCallerAppOwnsTask`
  // before the body, rejecting a caller that does not own the task.
  errors: [ForbiddenError, ParticipantNotAdmittedError],
})
```

TM-only: remove an agent from one conversation. The agent stays
in `task_participants` (so they may still receive messages on
other conversations within the task).

### [`TaskConversationUnarchive`](./tasks.ts#L447)

_Variable_

```ts
export const TaskConversationUnarchive = defineRpc({
  name: "task/conversation/unarchive",
  params: Schema.Struct({ taskId: TaskId, conversationId: ConversationId }),
  result: Schema.Struct({}),
  callablePrincipal: "app",
  caps: [ConversationInTask],
  // `ForbiddenError`: the app-arm handler runs `assertCallerAppOwnsTask`
  // before the body, rejecting a caller that does not own the task.
  errors: [ForbiddenError],
})
```

TM-only: reverse of `task/conversation/archive`.

### [`TaskConversationUnarchivedNotification`](./tasks.ts#L550)

_TypeAlias_

```ts
export type TaskConversationUnarchivedNotification = Schema.Schema.Type<
  typeof TaskConversationUnarchivedNotificationSchema
>;
```

### [`TaskConversationUnarchivedNotificationDefinition`](./tasks.ts#L574)

_Variable_

```ts
export const TaskConversationUnarchivedNotificationDefinition =
  defineNotification({
    name: "task/conversation/unarchived",
    params: TaskConversationUnarchivedNotificationSchema,
  })
```

### [`TaskCreatedNotificationDefinition`](./tasks.ts#L226)

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

### [`TaskFailedNotificationDefinition`](./tasks.ts#L214)

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

### [`TaskLeave`](./tasks.ts#L368)

_Variable_

```ts
export const TaskLeave = defineRpc({
  name: "task/leave",
  params: Schema.Struct({ taskId: TaskId }),
  result: Schema.Struct({}),
  callablePrincipal: "agent",
  requiresActive: true,
  errors: [TaskNotFoundError],
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

### [`TaskList`](./tasks.ts#L145)

_Variable_

```ts
export const TaskList = defineRpc({
  name: "task/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    tasks: Schema.Array(TaskSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  callablePrincipal: "agent",
  errors: [],
})
```

### [`TaskNotFoundError`](./tasks.ts#L44)

_Class_

```ts
export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>()(
  "TaskNotFound",
  errorPayloadFields,
) {
  static readonly message = "Task not found";
}
```

The referenced task does not exist (or the caller cannot see it).

### [`taskNotifications`](./methods.ts#L69)

_Variable_

```ts
export const taskNotifications = [
  MessageReceivedNotificationDefinition,
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
] as const
```

### [`TaskParticipant`](./tasks.ts#L143)

_TypeAlias_

```ts
export type TaskParticipant = Schema.Schema.Type<typeof TaskParticipantSchema>;
```

### [`TaskRejectedError`](./tasks.ts#L67)

_Class_

```ts
export class TaskRejectedError extends Schema.TaggedError<TaskRejectedError>()(
  "TaskRejected",
  errorPayloadFields,
) {
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

### [`TaskRemoveParticipant`](./tasks.ts#L182)

_Variable_

```ts
export const TaskRemoveParticipant = defineRpc({
  name: "task/removeParticipant",
  params: Schema.Struct({
    taskId: TaskId,
    agentId: AgentId,
  }),
  result: Schema.Struct({}),
  callablePrincipal: "app",
  // `ForbiddenError`: the app-arm handler runs `assertCallerAppOwnsTask`
  // before the body, rejecting a caller that does not own the task.
  errors: [ForbiddenError, TaskNotFoundError],
})
```

### [`TaskRequest`](./tasks.ts#L338)

_Variable_

```ts
export const TaskRequest = defineRpc({
  name: "task/request",
  params: Schema.Struct({
    appId: AppId,
    invitedAgentIds: Schema.Array(AgentId),
    initialConversation: Schema.optional(InitialConversationSchema),
  }),
  result: Schema.Struct({
    task: TaskSchema,
    conversation: Schema.Union(ConversationSchema, Schema.Null),
  }),
  callablePrincipal: "agent",
  requiresActive: true,
  caps: [ContactPolicyAllowsReach],
  errors: [TaskRejectedError],
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

### [`taskRpcMethods`](./methods.ts#L30)

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

### [`TaskStatus`](./tasks.ts#L117)

_TypeAlias_

```ts
export type TaskStatus = Schema.Schema.Type<typeof TaskStatusEnum>;
```

### [`validateDispatchDecision`](./messages.ts#L140)

_Variable_

```ts
export const validateDispatchDecision = closedGuard(DispatchDecisionSchema)
```

### [`validateMessage`](./messages.ts#L97)

_Variable_

```ts
export const validateMessage = closedGuard(MessageSchema)
```

### [`validateTextPart`](./messages.ts#L96)

_Variable_

```ts
export const validateTextPart = closedGuard(TextPartSchema)
```

## Files

- `conversations.ts`
- `ids.ts`
- `messages.ts`
- `methods.ts`
- `tasks.ts`
