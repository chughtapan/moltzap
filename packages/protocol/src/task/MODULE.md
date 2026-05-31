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

### [`Conversation`](./conversations.ts#L88)

_TypeAlias_

```ts
export type Conversation = Schema.Schema.Type<typeof ConversationSchema>;
```

### [`ConversationArchivedError`](./conversations.ts#L25)

_Class_

```ts
export class ConversationArchivedError extends Data.TaggedError(
  "ConversationArchived",
)<RpcErrorPayload> {
  static readonly code = -32022;
  static readonly message = "Conversation is archived";
}
```

### [`ConversationFullError`](./conversations.ts#L33)

_Class_

```ts
export class ConversationFullError extends Data.TaggedError(
  "ConversationFull",
)<RpcErrorPayload> {
  static readonly code = -32007;
  static readonly message = "Conversation is full";
}
```

### [`ConversationId`](./conversations.ts#L15)

_TypeAlias_

```ts
export const ConversationId = brandedId("ConversationId");
```

### [`ConversationId`](./conversations.ts#L15)

_Variable_

```ts
export const ConversationId = brandedId("ConversationId")
```

### [`ConversationParticipant`](./conversations.ts#L89)

_TypeAlias_

```ts
export type ConversationParticipant = Schema.Schema.Type<
  typeof ConversationParticipantSchema
>;
```

### [`conversationSchema`](./conversations.ts#L96)

_Function_

```ts
export function conversationSchema(): typeof ConversationSchema
```

### [`ConversationSummary`](./conversations.ts#L92)

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

### [`DispatchDecision`](./messages.ts#L113)

_TypeAlias_

```ts
export type DispatchDecision = Schema.Schema.Type<
  typeof DispatchDecisionSchema
>;
```

### [`dispatchDecisionSchema`](./messages.ts#L133)

_Function_

```ts
export function dispatchDecisionSchema(): typeof DispatchDecisionSchema
```

### [`HookBlockedError`](./tasks.ts#L54)

_Class_

```ts
export class HookBlockedError extends Data.TaggedError(
  "HookBlocked",
)<RpcErrorPayload> {
  static readonly code = -32019;
  static readonly message = "Hook blocked the dispatch";
}
```

### [`InitialConversationInput`](./tasks.ts#L273)

_TypeAlias_

```ts
export type InitialConversationInput = Schema.Schema.Type<
  typeof InitialConversationSchema
>;
```

### [`LeaseId`](./messages.ts#L14)

_TypeAlias_

```ts
export const LeaseId = brandedId("LeaseId");
```

### [`LeaseId`](./messages.ts#L14)

_Variable_

```ts
export const LeaseId = brandedId("LeaseId")
```

### [`LogicalClock`](./tasks.ts#L90)

_TypeAlias_

```ts
export type LogicalClock = Schema.Schema.Type<typeof LogicalClockSchema>;
```

### [`logicalClockSchema`](./tasks.ts#L92)

_Function_

```ts
export function logicalClockSchema(): typeof LogicalClockSchema
```

### [`Message`](./messages.ts#L73)

_TypeAlias_

```ts
export type Message = Schema.Schema.Type<typeof MessageSchema>;
```

### [`MessageId`](./conversations.ts#L22)

_TypeAlias_

```ts
export const MessageId = brandedId("MessageId");
```

### [`MessageId`](./conversations.ts#L22)

_Variable_

```ts
export const MessageId = brandedId("MessageId")
```

### [`messagePartsSchema`](./messages.ts#L78)

_Function_

```ts
export function messagePartsSchema(): typeof MessagePartsSchema
```

### [`MessageReceivedNotification`](./messages.ts#L192)

_TypeAlias_

```ts
export type MessageReceivedNotification = Schema.Schema.Type<
  typeof MessageReceivedNotificationSchema
>;
```

### [`MessageReceivedNotificationDefinition`](./messages.ts#L200)

_Variable_

```ts
export const MessageReceivedNotificationDefinition = defineNotification({
  name: "messages/received",
  params: MessageReceivedNotificationSchema,
})
```

Pushed when a new message is delivered to your WebSocket connection.

### [`MessagesList`](./messages.ts#L169)

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
})
```

List messages in a conversation with cursor-based pagination using sequence numbers.

### [`MessagesSend`](./messages.ts#L152)

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
})
```

Send a message to a conversation under a task. Both `taskId` and
`conversationId` are required; the conversation must already exist
(created via `task/conversation/create`) and the sender must be a
participant.

**Returns:** The created message with ID, sequence number, and timestamp.

### [`MessageWithDispatchDecision`](./messages.ts#L129)

_TypeAlias_

```ts
export type MessageWithDispatchDecision = Schema.Schema.Type<
  typeof MessageWithDispatchDecisionSchema
>;
```

### [`messageWithDispatchDecisionSchema`](./messages.ts#L137)

_Function_

```ts
export function messageWithDispatchDecisionSchema(): typeof MessageWithDispatchDecisionSchema
```

### [`Part`](./messages.ts#L55)

_TypeAlias_

```ts
export type Part = Schema.Schema.Type<typeof PartSchema>;
```

### [`ParticipantNotAdmittedError`](./tasks.ts#L69)

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

### [`Task`](./tasks.ts#L111)

_TypeAlias_

```ts
export type Task = Schema.Schema.Type<typeof TaskSchema>;
```

### [`TaskAddParticipant`](./tasks.ts#L145)

_Variable_

```ts
export const TaskAddParticipant = defineRpc({
  name: "task/addParticipant",
  params: Schema.Struct({
    taskId: TaskId,
    agentId: AgentId,
  }),
  result: Schema.Struct({ participant: TaskParticipantSchema }),
})
```

### [`TaskClose`](./tasks.ts#L139)

_Variable_

```ts
export const TaskClose = defineRpc({
  name: "task/close",
  params: Schema.Struct({ taskId: TaskId }),
  result: Schema.Struct({ task: TaskSchema }),
})
```

### [`TaskClosedError`](./tasks.ts#L29)

_Class_

```ts
export class TaskClosedError extends Data.TaggedError(
  "TaskClosed",
)<RpcErrorPayload> {
  static readonly code = -32020;
  static readonly message = "Task is closed";
}
```

### [`TaskClosedNotificationDefinition`](./tasks.ts#L203)

_Variable_

```ts
export const TaskClosedNotificationDefinition = defineNotification({
  name: "task/closed",
  params: TaskClosedNotificationSchema,
})
```

Pushed when a task closes.

### [`TaskConversationAddParticipant`](./tasks.ts#L404)

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
  // App-ownership is gated by the app-arm handler's
  // `assertCallerAppOwnsTask` BEFORE `requireAgentsAreInTaskParticipants`
  // (so a non-owner sees `ForbiddenError`, not the participant-admitted
  // state probe). `ConversationInTask` is woven by the server binding's
  // `CapabilityMiddleware` (#705 HALF-2).
})
```

TM-only: add an agent to one conversation. The agent MUST already
appear in `task_participants` for `taskId`; otherwise
`ParticipantNotAdmittedError`. Spec body Goal 1.

### [`TaskConversationArchive`](./tasks.ts#L386)

_Variable_

```ts
export const TaskConversationArchive = defineRpc({
  name: "task/conversation/archive",
  params: Schema.Struct({ taskId: TaskId, conversationId: ConversationId }),
  result: Schema.Struct({}),
})
```

TM-only: archive one conversation. Task stays open.

### [`TaskConversationArchivedNotification`](./tasks.ts#L482)

_TypeAlias_

```ts
export type TaskConversationArchivedNotification = Schema.Schema.Type<
  typeof TaskConversationArchivedNotificationSchema
>;
```

### [`TaskConversationArchivedNotificationDefinition`](./tasks.ts#L503)

_Variable_

```ts
export const TaskConversationArchivedNotificationDefinition =
  defineNotification({
    name: "task/conversation/archived",
    params: TaskConversationArchivedNotificationSchema,
  })
```

### [`TaskConversationCreate`](./tasks.ts#L343)

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
  // No descriptor-side capabilities (D #705 R3/R7). App-ownership is
  // gated by the app-arm handler's `assertCallerAppOwnsTask`, and
  // `ConversationCreateAuthorization` is provided INLINE by the handler
  // as a capacity-only proof (a TM minting on the task's behalf has no
  // agent contact-edges; targets are gated by
  // `requireAgentsAreInTaskParticipants`).
})
```

TM-only: mint a new conversation under an existing task. Every
entry in `participants` MUST already appear in `task_participants`
for `taskId`; violations return `ParticipantNotAdmittedError`.

### [`TaskConversationCreatedNotification`](./tasks.ts#L479)

_TypeAlias_

```ts
export type TaskConversationCreatedNotification = Schema.Schema.Type<
  typeof TaskConversationCreatedNotificationSchema
>;
```

### [`TaskConversationCreatedNotificationDefinition`](./tasks.ts#L496)

_Variable_

```ts
export const TaskConversationCreatedNotificationDefinition = defineNotification(
  {
    name: "task/conversation/created",
    params: TaskConversationCreatedNotificationSchema,
  },
)
```

### [`TaskConversationList`](./tasks.ts#L367)

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
})
```

Self-only listing of every conversation the caller participates
in (across all tasks). No filter params; archived rows are
included; callers filter `archivedAt` locally. See spec body
Goal 1 for the full pagination + visibility contract.

### [`TaskConversationListItem`](./tasks.ts#L283)

_TypeAlias_

```ts
export type TaskConversationListItem = Schema.Schema.Type<
  typeof TaskConversationListItemSchema
>;
```

### [`TaskConversationParticipantsAddedNotification`](./tasks.ts#L488)

_TypeAlias_

```ts
export type TaskConversationParticipantsAddedNotification = Schema.Schema.Type<
  typeof TaskConversationParticipantsAddedNotificationSchema
>;
```

### [`TaskConversationParticipantsAddedNotificationDefinition`](./tasks.ts#L515)

_Variable_

```ts
export const TaskConversationParticipantsAddedNotificationDefinition =
  defineNotification({
    name: "task/conversation/participants/added",
    params: TaskConversationParticipantsAddedNotificationSchema,
  })
```

### [`TaskConversationParticipantsRemovedNotification`](./tasks.ts#L491)

_TypeAlias_

```ts
export type TaskConversationParticipantsRemovedNotification =
  Schema.Schema.Type<
    typeof TaskConversationParticipantsRemovedNotificationSchema
  >;
```

### [`TaskConversationParticipantsRemovedNotificationDefinition`](./tasks.ts#L521)

_Variable_

```ts
export const TaskConversationParticipantsRemovedNotificationDefinition =
  defineNotification({
    name: "task/conversation/participants/removed",
    params: TaskConversationParticipantsRemovedNotificationSchema,
  })
```

### [`TaskConversationRemoveParticipant`](./tasks.ts#L424)

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
})
```

TM-only: remove an agent from one conversation. The agent stays
in `task_participants` (so they may still receive messages on
other conversations within the task).

### [`TaskConversationUnarchive`](./tasks.ts#L393)

_Variable_

```ts
export const TaskConversationUnarchive = defineRpc({
  name: "task/conversation/unarchive",
  params: Schema.Struct({ taskId: TaskId, conversationId: ConversationId }),
  result: Schema.Struct({}),
})
```

TM-only: reverse of `task/conversation/archive`.

### [`TaskConversationUnarchivedNotification`](./tasks.ts#L485)

_TypeAlias_

```ts
export type TaskConversationUnarchivedNotification = Schema.Schema.Type<
  typeof TaskConversationUnarchivedNotificationSchema
>;
```

### [`TaskConversationUnarchivedNotificationDefinition`](./tasks.ts#L509)

_Variable_

```ts
export const TaskConversationUnarchivedNotificationDefinition =
  defineNotification({
    name: "task/conversation/unarchived",
    params: TaskConversationUnarchivedNotificationSchema,
  })
```

### [`TaskCreatedNotificationDefinition`](./tasks.ts#L194)

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

### [`TaskFailedNotificationDefinition`](./tasks.ts#L182)

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

### [`TaskLeave`](./tasks.ts#L332)

_Variable_

```ts
export const TaskLeave = defineRpc({
  name: "task/leave",
  params: Schema.Struct({ taskId: TaskId }),
  result: Schema.Struct({}),
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

### [`TaskList`](./tasks.ts#L127)

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
})
```

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

### [`TaskParticipant`](./tasks.ts#L125)

_TypeAlias_

```ts
export type TaskParticipant = Schema.Schema.Type<typeof TaskParticipantSchema>;
```

### [`TaskRejectedError`](./tasks.ts#L46)

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

### [`TaskRemoveParticipant`](./tasks.ts#L154)

_Variable_

```ts
export const TaskRemoveParticipant = defineRpc({
  name: "task/removeParticipant",
  params: Schema.Struct({
    taskId: TaskId,
    agentId: AgentId,
  }),
  result: Schema.Struct({}),
})
```

### [`TaskRequest`](./tasks.ts#L306)

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

### [`TaskStatus`](./tasks.ts#L99)

_TypeAlias_

```ts
export type TaskStatus = Schema.Schema.Type<typeof TaskStatusEnum>;
```

### [`validateDispatchDecision`](./messages.ts#L120)

_Variable_

```ts
export const validateDispatchDecision = closedStructGuard(
  DispatchDecisionSchema,
)
```

### [`validateMessage`](./messages.ts#L76)

_Variable_

```ts
export const validateMessage = closedStructGuard(MessageSchema)
```

### [`validateTextPart`](./messages.ts#L75)

_Variable_

```ts
export const validateTextPart = closedStructGuard(TextPartSchema)
```

## Files

- `conversations.ts`
- `ids.ts`
- `messages.ts`
- `methods.ts`
- `tasks.ts`
