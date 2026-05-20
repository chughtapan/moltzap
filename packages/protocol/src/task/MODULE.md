# protocol/task

_`packages/protocol/src/task`_

## Purpose

Public barrel for task, conversation, message, and task-manager protocol descriptors.

## Public surface

### [`agentParticipantRefSchema`](./conversations.ts#L123)

_Function_

```ts
export function agentParticipantRefSchema(): typeof AgentParticipantRefSchema
```

### [`Conversation`](./conversations.ts#L117)

_TypeAlias_

```ts
export type Conversation = Static<typeof ConversationSchema>;
```

### [`ConversationArchivedError`](./conversations.ts#L43)

_Class_

```ts
export class ConversationArchivedError extends Data.TaggedError(
  "ConversationArchived",
)<RpcErrorPayload> {
  static readonly code = -32022;
  static readonly message = "Conversation is archived";
}
```

### [`ConversationArchivedNotification`](./conversations.ts#L389)

_TypeAlias_

```ts
export type ConversationArchivedNotification = Static<
  typeof ConversationArchivedNotificationSchema
>;
```

### [`ConversationArchivedNotificationDefinition`](./conversations.ts#L412)

_Variable_

```ts
export const ConversationArchivedNotificationDefinition = defineNotification(
```

### [`ConversationCreatedNotification`](./conversations.ts#L383)

_TypeAlias_

```ts
export type ConversationCreatedNotification = Static<
  typeof ConversationCreatedNotificationSchema
>;
```

### [`ConversationCreatedNotificationDefinition`](./conversations.ts#L402)

_Variable_

```ts
export const ConversationCreatedNotificationDefinition = defineNotification(
```

### [`ConversationFullError`](./conversations.ts#L51)

_Class_

```ts
export class ConversationFullError extends Data.TaggedError(
  "ConversationFull",
)<RpcErrorPayload> {
  static readonly code = -32007;
  static readonly message = "Conversation is full";
}
```

### [`ConversationId`](./conversations.ts#L33)

_TypeAlias_

```ts
export const ConversationId = brandedId("ConversationId");
```

### [`ConversationId`](./conversations.ts#L33)

_Variable_

```ts
export const ConversationId = brandedId("ConversationId")
```

### [`ConversationParticipant`](./conversations.ts#L118)

_TypeAlias_

```ts
export type ConversationParticipant = Static<
  typeof ConversationParticipantSchema
>;
```

### [`ConversationsAddParticipant`](./conversations.ts#L250)

_Variable_

```ts
export const ConversationsAddParticipant = defineRpc(
```

### [`ConversationsArchive`](./conversations.ts#L306)

_Variable_

```ts
export const ConversationsArchive = defineRpc(
```

### [`conversationSchema`](./conversations.ts#L127)

_Function_

```ts
export function conversationSchema(): typeof ConversationSchema
```

### [`ConversationsCreate`](./conversations.ts#L131)

_Variable_

```ts
export const ConversationsCreate = defineRpc(
```

### [`ConversationsGet`](./conversations.ts#L186)

_Variable_

```ts
export const ConversationsGet = defineRpc(
```

### [`ConversationsLeave`](./conversations.ts#L297)

_Variable_

```ts
export const ConversationsLeave = defineRpc(
```

### [`ConversationsList`](./conversations.ts#L167)

_Variable_

```ts
export const ConversationsList = defineRpc(
```

### [`ConversationsMute`](./conversations.ts#L229)

_Variable_

```ts
export const ConversationsMute = defineRpc(
```

### [`ConversationsRemoveParticipant`](./conversations.ts#L285)

_Variable_

```ts
export const ConversationsRemoveParticipant = defineRpc(
```

### [`ConversationSummary`](./conversations.ts#L121)

_TypeAlias_

```ts
export type ConversationSummary = Static<typeof ConversationSummarySchema>;
```

### [`ConversationsUnarchive`](./conversations.ts#L315)

_Variable_

```ts
export const ConversationsUnarchive = defineRpc(
```

### [`ConversationsUnmute`](./conversations.ts#L241)

_Variable_

```ts
export const ConversationsUnmute = defineRpc(
```

### [`ConversationsUpdate`](./conversations.ts#L214)

_Variable_

```ts
export const ConversationsUpdate = defineRpc(
```

### [`ConversationTypeEnum`](./conversations.ts#L59)

_Variable_

```ts
export const ConversationTypeEnum = stringEnum(["dm", "group"])
```

### [`ConversationUnarchivedNotification`](./conversations.ts#L392)

_TypeAlias_

```ts
export type ConversationUnarchivedNotification = Static<
  typeof ConversationUnarchivedNotificationSchema
>;
```

### [`ConversationUnarchivedNotificationDefinition`](./conversations.ts#L417)

_Variable_

```ts
export const ConversationUnarchivedNotificationDefinition = defineNotification(
```

### [`ConversationUpdatedNotification`](./conversations.ts#L386)

_TypeAlias_

```ts
export type ConversationUpdatedNotification = Static<
  typeof ConversationUpdatedNotificationSchema
>;
```

### [`ConversationUpdatedNotificationDefinition`](./conversations.ts#L407)

_Variable_

```ts
export const ConversationUpdatedNotificationDefinition = defineNotification(
```

### [`HookBlockedError`](./tasks.ts#L53)

_Class_

```ts
export class HookBlockedError extends Data.TaggedError(
  "HookBlocked",
)<RpcErrorPayload> {
  static readonly code = -32019;
  static readonly message = "Hook blocked the dispatch";
}
```

### [`LogicalClock`](./tasks.ts#L74)

_TypeAlias_

```ts
export type LogicalClock = Static<typeof LogicalClockSchema>;
```

### [`logicalClockSchema`](./tasks.ts#L76)

_Function_

```ts
export function logicalClockSchema(): typeof LogicalClockSchema
```

### [`Message`](./messages.ts#L65)

_TypeAlias_

```ts
export type Message = Static<typeof MessageSchema>;
```

### [`MessageId`](./conversations.ts#L40)

_TypeAlias_

```ts
export const MessageId = brandedId("MessageId");
```

### [`MessageId`](./conversations.ts#L40)

_Variable_

```ts
export const MessageId = brandedId("MessageId")
```

### [`messagePartsSchema`](./messages.ts#L74)

_Function_

```ts
export function messagePartsSchema(): typeof MessagePartsSchema
```

### [`MessageReceivedNotification`](./messages.ts#L196)

_TypeAlias_

```ts
export type MessageReceivedNotification = Static<
  typeof MessageReceivedNotificationSchema
>;
```

### [`MessageReceivedNotificationDefinition`](./messages.ts#L200)

_Variable_

```ts
export const MessageReceivedNotificationDefinition = defineNotification(
```

### [`messageSchema`](./messages.ts#L78)

_Function_

```ts
export function messageSchema(): typeof MessageSchema
```

### [`MessagesList`](./messages.ts#L173)

_Variable_

```ts
export const MessagesList = defineRpc(
```

### [`MessagesSend`](./messages.ts#L145)

_Variable_

```ts
export const MessagesSend = defineRpc(
```

### [`MessageWithTmDecision`](./messages.ts#L135)

_TypeAlias_

```ts
export type MessageWithTmDecision = Static<typeof MessageWithTmDecisionSchema>;
```

### [`messageWithTmDecisionSchema`](./messages.ts#L141)

_Function_

```ts
export function messageWithTmDecisionSchema(): typeof MessageWithTmDecisionSchema
```

### [`Part`](./messages.ts#L44)

_TypeAlias_

```ts
export type Part = Static<typeof PartSchema>;
```

### [`ParticipantsAddedNotification`](./conversations.ts#L395)

_TypeAlias_

```ts
export type ParticipantsAddedNotification = Static<
  typeof ParticipantsAddedNotificationSchema
>;
```

### [`ParticipantsAddedNotificationDefinition`](./conversations.ts#L422)

_Variable_

```ts
export const ParticipantsAddedNotificationDefinition = defineNotification(
```

### [`ParticipantsRemovedNotification`](./conversations.ts#L398)

_TypeAlias_

```ts
export type ParticipantsRemovedNotification = Static<
  typeof ParticipantsRemovedNotificationSchema
>;
```

### [`ParticipantsRemovedNotificationDefinition`](./conversations.ts#L427)

_Variable_

```ts
export const ParticipantsRemovedNotificationDefinition = defineNotification(
```

### [`Task`](./tasks.ts#L106)

_TypeAlias_

```ts
export type Task = Static<typeof TaskSchema>;
```

### [`TaskClosedError`](./tasks.ts#L45)

_Class_

```ts
export class TaskClosedError extends Data.TaggedError(
  "TaskClosed",
)<RpcErrorPayload> {
  static readonly code = -32020;
  static readonly message = "Task is closed";
}
```

### [`TaskClosedNotificationDefinition`](./tasks.ts#L462)

_Variable_

```ts
export const TaskClosedNotificationDefinition = defineNotification(
```

### [`TaskFailedNotificationDefinition`](./tasks.ts#L457)

_Variable_

```ts
export const TaskFailedNotificationDefinition = defineNotification(
```

### [`TaskId`](./tasks.ts#L42)

_TypeAlias_

```ts
export const TaskId = brandedId("TaskId");
```

### [`TaskId`](./tasks.ts#L42)

_Variable_

```ts
export const TaskId = brandedId("TaskId")
```

### [`taskNotifications`](./methods.ts#L72)

_Variable_

```ts
export const taskNotifications = [
  ConversationCreatedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  ConversationArchivedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  ParticipantsAddedNotificationDefinition,
  ParticipantsRemovedNotificationDefinition,
  MessageReceivedNotificationDefinition,
  TaskClosedNotificationDefinition,
  TaskFailedNotificationDefinition,
] as const
```

### [`TaskParticipant`](./tasks.ts#L118)

_TypeAlias_

```ts
export type TaskParticipant = Static<typeof TaskParticipantSchema>;
```

### [`taskRpcMethods`](./methods.ts#L45)

_Variable_

```ts
export const taskRpcMethods = [
  ConversationsCreate,
  ConversationsList,
  ConversationsGet,
  ConversationsUpdate,
  ConversationsMute,
  ConversationsUnmute,
  ConversationsAddParticipant,
  ConversationsRemoveParticipant,
  ConversationsLeave,
  ConversationsArchive,
  ConversationsUnarchive,
  MessagesSend,
  MessagesList,
  TasksCreate,
  TasksGet,
  TasksList,
  TasksClose,
  TasksCreateConversation,
  TasksCloseConversation,
  TasksAddParticipant,
  TasksRemoveParticipant,
  TasksStoreMessage,
  TasksGetMessages,
  TasksGetMessagesSince,
] as const
```

### [`TasksAddParticipant`](./tasks.ts#L264)

_Variable_

```ts
export const TasksAddParticipant = defineRpc(
```

### [`TasksClose`](./tasks.ts#L171)

_Variable_

```ts
export const TasksClose = defineRpc(
```

### [`TasksCloseConversation`](./tasks.ts#L232)

_Variable_

```ts
export const TasksCloseConversation = defineRpc(
```

### [`TasksCreate`](./tasks.ts#L120)

_Variable_

```ts
export const TasksCreate = defineRpc(
```

### [`TasksCreateConversation`](./tasks.ts#L187)

_Variable_

```ts
export const TasksCreateConversation = defineRpc(
```

### [`TasksGet`](./tasks.ts#L133)

_Variable_

```ts
export const TasksGet = defineRpc(
```

### [`TasksGetMessages`](./tasks.ts#L366)

_Variable_

```ts
export const TasksGetMessages = defineRpc(
```

### [`TasksGetMessagesSince`](./tasks.ts#L405)

_Variable_

```ts
export const TasksGetMessagesSince = defineRpc(
```

### [`TasksList`](./tasks.ts#L155)

_Variable_

```ts
export const TasksList = defineRpc(
```

### [`TasksRemoveParticipant`](./tasks.ts#L289)

_Variable_

```ts
export const TasksRemoveParticipant = defineRpc(
```

### [`TasksStoreMessage`](./tasks.ts#L311)

_Variable_

```ts
export const TasksStoreMessage = defineRpc(
```

### [`TaskStatus`](./tasks.ts#L86)

_TypeAlias_

```ts
export type TaskStatus = Static<typeof TaskStatusEnum>;
```

### [`TmDecision`](./messages.ts#L122)

_TypeAlias_

```ts
export type TmDecision = Static<typeof TmDecisionSchema>;
```

### [`tmDecisionSchema`](./messages.ts#L137)

_Function_

```ts
export function tmDecisionSchema(): typeof TmDecisionSchema
```

### [`TmType`](./tasks.ts#L81)

_TypeAlias_

```ts
export type TmType = (typeof TmTypeEnum)["static"];
```

### [`validateMessage`](./messages.ts#L70)

_Variable_

```ts
export const validateMessage = ajv.compile(MessageSchema) as (
  value: unknown,
)
```

### [`validateTextPart`](./messages.ts#L67)

_Variable_

```ts
export const validateTextPart = ajv.compile(TextPartSchema) as (
  value: unknown,
)
```

### [`validateTmDecision`](./messages.ts#L123)

_Variable_

```ts
export const validateTmDecision = ajv.compile(TmDecisionSchema) as (
  value: unknown,
)
```

## Files

- `conversations.ts`
- `messages.ts`
- `methods.ts`
- `tasks.ts`
