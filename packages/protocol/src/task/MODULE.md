# protocol/task

_`packages/protocol/src/task`_

## Purpose

Public barrel for task, conversation, message, and task-manager protocol descriptors.

## Public surface

### [`_D1DefaultAppIdCanary`](./task-conversation-family.types-check.ts#L186)

_TypeAlias_

```ts
export type _D1DefaultAppIdCanary = Expect<Equal<typeof DEFAULT_APP_ID, AppId>>;
```

### [`_D1ListItemCanary`](./task-conversation-family.types-check.ts#L210)

_TypeAlias_

```ts
export type _D1ListItemCanary = _L1 | _L2 | _L3 | _L4;
```

### [`_D1NegativeCanary`](./task-conversation-family.types-check.ts#L259)

_TypeAlias_

```ts
export type _D1NegativeCanary =
  | _NoUpdate
  | _NoGet
  | _NoMute
  | _NoUnmute
  | _NoConvLeave
  | _NoUpdatedNotif;
```

### [`_D1RemovedReasonCanary`](./task-conversation-family.types-check.ts#L237)

_TypeAlias_

```ts
export type _D1RemovedReasonCanary = _R1 | _R2 | _R3;
```

### [`_D1TaskCreateShapeCanary`](./task-conversation-family.types-check.ts#L176)

_TypeAlias_

```ts
export type _D1TaskCreateShapeCanary = _C1 | _C2 | _C3 | _C4 | _C5;
```

### [`_D1WireNameCanary`](./task-conversation-family.types-check.ts#L136)

_TypeAlias_

```ts
export type _D1WireNameCanary =
  | _N1
  | _N2
  | _N3
  | _N4
  | _N5
  | _N6
  | _N7
  | _N8
  | _N9
  | _N10
  | _N11
  | _N12
  | _N13;
```

### [`_D3CanaryHolds`](./task-d3-cutover.types-check.ts#L134)

_TypeAlias_

```ts
export type _D3CanaryHolds =
  | _CardinalityHolds
  | _TmOnlyHasClose
  | _TmOnlyHasConvCreate
  | _TmOnlyHasConvArchive
  | _TmOnlyHasConvUnarchive
  | _TmOnlyHasAddPart
  | _TmOnlyHasRemovePart
  | _AgentHasCreate
  | _AgentHasLeave
  | _AgentHasList
  | _AgentHasMessagesSend
  | _AgentHasMessagesList
  | _TaskCloseNotInAgentSet
  | _ConvCreateNotInAgentSet
  | _ServerSupersetOfTm
  | _RpcErrorPayloadDataIsJsonValue
  | _TaskRequestWireName
  | _TaskCreateCallbackWireName;
```

### [`_NonTmAuthorityCanary`](./task-d3-cutover.types-check.ts#L156)

_TypeAlias_

```ts
export type _NonTmAuthorityCanary =
  (typeof nonTmAuthorityTaskRpcMethods)["length"];
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

### [`HookBlockedError`](./tasks.ts#L63)

_Class_

```ts
export class HookBlockedError extends Data.TaggedError(
  "HookBlocked",
)<RpcErrorPayload> {
  static readonly code = -32019;
  static readonly message = "Hook blocked the dispatch";
}
```

### [`InitialConversationInput`](./tasks.ts#L349)

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

### [`LogicalClock`](./tasks.ts#L99)

_TypeAlias_

```ts
export type LogicalClock = Static<typeof LogicalClockSchema>;
```

### [`logicalClockSchema`](./tasks.ts#L101)

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

### [`MessageReceivedNotification`](./messages.ts#L269)

_TypeAlias_

```ts
export type MessageReceivedNotification = Static<
  typeof MessageReceivedNotificationSchema
>;
```

### [`MessageReceivedNotificationDefinition`](./messages.ts#L277)

_Variable_

```ts
export const MessageReceivedNotificationDefinition = defineNotification(
```

Pushed when a new message is delivered to your WebSocket connection.

### [`MessagesList`](./messages.ts#L218)

_Variable_

```ts
export const MessagesList = defineRpc(
```

List messages in a conversation with cursor-based pagination using sequence numbers.

### [`MessagesSend`](./messages.ts#L159)

_Variable_

```ts
export const MessagesSend = defineRpc(
```

Send a message to a conversation or agent. Creates a DM automatically when using `to: "agent:&lt;name>"`.

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

### [`ParticipantNotAdmittedError`](./tasks.ts#L78)

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

### [`Task`](./tasks.ts#L123)

_TypeAlias_

```ts
export type Task = Static<typeof TaskSchema>;
```

### [`TaskAddParticipant`](./tasks.ts#L177)

_Variable_

```ts
export const TaskAddParticipant = defineRpc(
```

### [`TaskClose`](./tasks.ts#L157)

_Variable_

```ts
export const TaskClose = defineRpc(
```

### [`TaskClosedError`](./tasks.ts#L38)

_Class_

```ts
export class TaskClosedError extends Data.TaggedError(
  "TaskClosed",
)<RpcErrorPayload> {
  static readonly code = -32020;
  static readonly message = "Task is closed";
}
```

### [`TaskClosedNotificationDefinition`](./tasks.ts#L279)

_Variable_

```ts
export const TaskClosedNotificationDefinition = defineNotification(
```

Pushed when a task closes.

### [`TaskConversationAddParticipant`](./tasks.ts#L558)

_Variable_

```ts
export const TaskConversationAddParticipant = defineRpc(
```

TM-only: add an agent to one conversation. The agent MUST already
appear in `task_participants` for `taskId`; otherwise
`ParticipantNotAdmittedError`. Spec body Goal 1.

### [`TaskConversationArchive`](./tasks.ts#L526)

_Variable_

```ts
export const TaskConversationArchive = defineRpc(
```

TM-only: archive one conversation. Task stays open.

### [`TaskConversationArchivedNotification`](./tasks.ts#L665)

_TypeAlias_

```ts
export type TaskConversationArchivedNotification = Static<
  typeof TaskConversationArchivedNotificationSchema
>;
```

### [`TaskConversationArchivedNotificationDefinition`](./tasks.ts#L685)

_Variable_

```ts
export const TaskConversationArchivedNotificationDefinition =
  defineNotification(
```

### [`TaskConversationCreate`](./tasks.ts#L426)

_Variable_

```ts
export const TaskConversationCreate = defineRpc(
```

TM-only: mint a new conversation under an existing task. Every
entry in `participants` MUST already appear in `task_participants`
for `taskId`; violations return `ParticipantNotAdmittedError`.

### [`TaskConversationCreatedNotification`](./tasks.ts#L662)

_TypeAlias_

```ts
export type TaskConversationCreatedNotification = Static<
  typeof TaskConversationCreatedNotificationSchema
>;
```

### [`TaskConversationCreatedNotificationDefinition`](./tasks.ts#L678)

_Variable_

```ts
export const TaskConversationCreatedNotificationDefinition = defineNotification(
```

### [`TaskConversationList`](./tasks.ts#L484)

_Variable_

```ts
export const TaskConversationList = defineRpc(
```

Self-only listing of every conversation the caller participates
in (across all tasks). No filter params; archived rows are
included; callers filter `archivedAt` locally. See spec body
Goal 1 for the full pagination + visibility contract.

### [`TaskConversationListItem`](./tasks.ts#L360)

_TypeAlias_

```ts
export type TaskConversationListItem = Static<
  typeof TaskConversationListItemSchema
>;
```

### [`TaskConversationParticipantsAddedNotification`](./tasks.ts#L671)

_TypeAlias_

```ts
export type TaskConversationParticipantsAddedNotification = Static<
  typeof TaskConversationParticipantsAddedNotificationSchema
>;
```

### [`TaskConversationParticipantsAddedNotificationDefinition`](./tasks.ts#L697)

_Variable_

```ts
export const TaskConversationParticipantsAddedNotificationDefinition =
  defineNotification(
```

### [`TaskConversationParticipantsRemovedNotification`](./tasks.ts#L674)

_TypeAlias_

```ts
export type TaskConversationParticipantsRemovedNotification = Static<
  typeof TaskConversationParticipantsRemovedNotificationSchema
>;
```

### [`TaskConversationParticipantsRemovedNotificationDefinition`](./tasks.ts#L703)

_Variable_

```ts
export const TaskConversationParticipantsRemovedNotificationDefinition =
  defineNotification(
```

### [`TaskConversationRemoveParticipant`](./tasks.ts#L585)

_Variable_

```ts
export const TaskConversationRemoveParticipant = defineRpc(
```

TM-only: remove an agent from one conversation. The agent stays
in `task_participants` (so they may still receive messages on
other conversations within the task).

### [`TaskConversationUnarchive`](./tasks.ts#L540)

_Variable_

```ts
export const TaskConversationUnarchive = defineRpc(
```

TM-only: reverse of `task/conversation/archive`.

### [`TaskConversationUnarchivedNotification`](./tasks.ts#L668)

_TypeAlias_

```ts
export type TaskConversationUnarchivedNotification = Static<
  typeof TaskConversationUnarchivedNotificationSchema
>;
```

### [`TaskConversationUnarchivedNotificationDefinition`](./tasks.ts#L691)

_Variable_

```ts
export const TaskConversationUnarchivedNotificationDefinition =
  defineNotification(
```

### [`TaskCreatedNotificationDefinition`](./tasks.ts#L270)

_Variable_

```ts
export const TaskCreatedNotificationDefinition = defineNotification(
```

Pushed to the task initiator + invited participants after the TM
accepts via the `task/create` wire callback and the task
transitions from `waiting` to `active`. Carries the full Task row
(matching `task/closed`'s shape) so subscribers don't need a
second read to discover the post-transition state.

### [`TaskFailedNotificationDefinition`](./tasks.ts#L258)

_Variable_

```ts
export const TaskFailedNotificationDefinition = defineNotification(
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

### [`TaskLeave`](./tasks.ts#L415)

_Variable_

```ts
export const TaskLeave = defineRpc(
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

### [`TaskList`](./tasks.ts#L142)

_Variable_

```ts
export const TaskList = defineRpc(
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

### [`TaskParticipant`](./tasks.ts#L140)

_TypeAlias_

```ts
export type TaskParticipant = Static<typeof TaskParticipantSchema>;
```

### [`TaskRejectedError`](./tasks.ts#L55)

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

### [`TaskRemoveParticipant`](./tasks.ts#L206)

_Variable_

```ts
export const TaskRemoveParticipant = defineRpc(
```

### [`TaskRequest`](./tasks.ts#L383)

_Variable_

```ts
export const TaskRequest = defineRpc(
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

### [`TaskStatus`](./tasks.ts#L108)

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
- `task-conversation-family.types-check.ts`
- `task-d3-cutover.types-check.ts`
- `tasks.ts`
