# protocol/conversation

_`packages/protocol/src/conversation`_

## Purpose

Public conversation-domain barrel.

## Public surface

### [`agentCallableConversationRpcMethods`](./conversations.ts#L260)

_Variable_

```ts
export const agentCallableConversationRpcMethods = [ConversationList] as const
```

Agent-callable conversation RPC catalog.

### [`appCallableConversationRpcMethods`](./conversations.ts#L263)

_Variable_

```ts
export const appCallableConversationRpcMethods = [
  ConversationCreate,
  ConversationUpdate,
] as const
```

App-callable conversation RPC catalog.

### [`Conversation`](./types.ts#L129)

_TypeAlias_

```ts
export type Conversation = Schema.Schema.Type<typeof ConversationSchema>;
```

Conversation row visible on task conversation surfaces.

### [`ConversationArchivedError`](./types.ts#L55)

_Class_

```ts
export class ConversationArchivedError extends Schema.TaggedError<ConversationArchivedError>()(
  "ConversationArchived",
  errorPayloadFields,
) {
  static readonly message = "Conversation is archived";
}
```

The conversation is archived and cannot accept the requested mutation.

### [`ConversationArchivedNotification`](./conversations.ts#L208)

_TypeAlias_

```ts
export type ConversationArchivedNotification = Schema.Schema.Type<
  typeof ConversationArchivedNotificationSchema
>;
```

Notification payload for `agent/conversation/archived`.

### [`ConversationArchivedNotificationDefinition`](./conversations.ts#L234)

_Variable_

```ts
export const ConversationArchivedNotificationDefinition = defineNotification({
  name: "agent/conversation/archived",
  params: ConversationArchivedNotificationSchema,
})
```

Pushed when a task conversation is archived.

### [`ConversationCreate`](./conversations.ts#L52)

_Variable_

```ts
export const ConversationCreate = defineRpc({
  name: "app/conversation/create",
  params: Schema.Struct({
    taskId: TaskId,
    name: Schema.optional(ConversationNameSchema),
    participants: Schema.Array(AgentId).pipe(Schema.minItems(1)),
  }),
  result: Schema.Struct({ conversation: ConversationSchema }),
  requires: [AppPrincipal],
  errors: [
    ForbiddenError,
    TaskNotFoundError,
    AgentNotFoundError,
    ParticipantNotAdmittedError,
    ConversationFullError,
  ],
})
```

App-only: mint a new conversation under an existing task. Every
entry in `participants` MUST already appear in `task_participants`
for `taskId`; violations return `ParticipantNotAdmittedError`.

- **Principal:** `AppPrincipal` head. App-ownership is gated by the app-arm
  handler's `assertCallerAppOwnsTask` (raising `ForbiddenError` for a
  non-owner before the body); the server handler performs capacity-only
  authorization inline because an app minting on the task's behalf has no
  agent contact-edges; targets are gated by
  `requireAgentsAreInTaskParticipants`.

### [`ConversationCreatedNotification`](./conversations.ts#L203)

_TypeAlias_

```ts
export type ConversationCreatedNotification = Schema.Schema.Type<
  typeof ConversationCreatedNotificationSchema
>;
```

Notification payload for `agent/conversation/created`.

### [`ConversationCreatedNotificationDefinition`](./conversations.ts#L228)

_Variable_

```ts
export const ConversationCreatedNotificationDefinition = defineNotification({
  name: "agent/conversation/created",
  params: ConversationCreatedNotificationSchema,
})
```

Pushed when a task conversation is created.

### [`ConversationFullError`](./types.ts#L63)

_Class_

```ts
export class ConversationFullError extends Schema.TaggedError<ConversationFullError>()(
  "ConversationFull",
  errorPayloadFields,
) {
  static readonly message = "Conversation is full";
}
```

The conversation has reached its participant capacity.

### [`ConversationId`](./types.ts#L16)

_TypeAlias_

```ts
export type ConversationId = string & Brand.Brand<"ConversationId">;
```

Branded conversation identifier.

### [`ConversationId`](./types.ts#L16)

_Variable_

```ts
export type ConversationId = string & Brand.Brand<"ConversationId">
```

### [`ConversationList`](./conversations.ts#L94)

_Variable_

```ts
export const ConversationList = defineRpc({
  name: "agent/conversation/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({
    items: Schema.Array(ConversationListItemSchema),
    nextCursor: Schema.optional(Schema.String),
  }),
  requires: [AgentPrincipal, ActiveAgent],
  errors: [InvalidParamsError, ConversationNotFoundError],
})
```

Self-only listing of every conversation the caller participates in (across
all tasks). No filter params; archived rows are included; callers filter
`archivedAt` locally.

- **Principal:** `AgentPrincipal` head + `ActiveAgent` (active agent).

### [`ConversationListItem`](./conversations.ts#L81)

_TypeAlias_

```ts
export type ConversationListItem = Schema.Schema.Type<
  typeof ConversationListItemSchema
>;
```

Conversation list item returned by `agent/conversation/list`.

### [`ConversationNameSchema`](./name.ts#L4)

_Variable_

```ts
export const ConversationNameSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(100),
)
```

Display name accepted when a conversation is created.

### [`ConversationNotFoundError`](./types.ts#L39)

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

### [`conversationNotifications`](./conversations.ts#L269)

_Variable_

```ts
export const conversationNotifications = [
  ConversationCreatedNotificationDefinition,
  ConversationArchivedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  ConversationParticipantsAddedNotificationDefinition,
  ConversationParticipantsRemovedNotificationDefinition,
] as const
```

Conversation notification catalog.

### [`ConversationParticipant`](./types.ts#L132)

_TypeAlias_

```ts
export type ConversationParticipant = Schema.Schema.Type<
  typeof ConversationParticipantSchema
>;
```

Participant row for a conversation.

### [`ConversationParticipantsAddedNotification`](./conversations.ts#L218)

_TypeAlias_

```ts
export type ConversationParticipantsAddedNotification = Schema.Schema.Type<
  typeof ConversationParticipantsAddedNotificationSchema
>;
```

Notification payload for `agent/conversation/participants-added`.

### [`ConversationParticipantsAddedNotificationDefinition`](./conversations.ts#L246)

_Variable_

```ts
export const ConversationParticipantsAddedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/participants-added",
    params: ConversationParticipantsAddedNotificationSchema,
  })
```

Pushed when a participant is added to a task conversation.

### [`ConversationParticipantsRemovedNotification`](./conversations.ts#L223)

_TypeAlias_

```ts
export type ConversationParticipantsRemovedNotification = Schema.Schema.Type<
  typeof ConversationParticipantsRemovedNotificationSchema
>;
```

Notification payload for `agent/conversation/participants-removed`.

### [`ConversationParticipantsRemovedNotificationDefinition`](./conversations.ts#L253)

_Variable_

```ts
export const ConversationParticipantsRemovedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/participants-removed",
    params: ConversationParticipantsRemovedNotificationSchema,
  })
```

Pushed when a participant is removed from a task conversation.

### [`conversationSchema`](./types.ts#L145)

_Function_

```ts
export function conversationSchema(): typeof ConversationSchema
```

Return the canonical conversation schema.

**Returns:** The canonical conversation schema.

### [`ConversationSummary`](./types.ts#L137)

_TypeAlias_

```ts
export type ConversationSummary = Schema.Schema.Type<
  typeof ConversationSummarySchema
>;
```

Conversation summary row used by list surfaces.

### [`ConversationUnarchivedNotification`](./conversations.ts#L213)

_TypeAlias_

```ts
export type ConversationUnarchivedNotification = Schema.Schema.Type<
  typeof ConversationUnarchivedNotificationSchema
>;
```

Notification payload for `agent/conversation/unarchived`.

### [`ConversationUnarchivedNotificationDefinition`](./conversations.ts#L240)

_Variable_

```ts
export const ConversationUnarchivedNotificationDefinition = defineNotification({
  name: "agent/conversation/unarchived",
  params: ConversationUnarchivedNotificationSchema,
})
```

Pushed when a task conversation is unarchived.

### [`ConversationUpdate`](./conversations.ts#L147)

_Variable_

```ts
export const ConversationUpdate = defineRpc({
  name: "app/conversation/update",
  params: ConversationUpdateParamsSchema,
  result: Schema.Struct({}),
  requires: [AppPrincipal, ConversationInTask],
  errors: [
    ForbiddenError,
    TaskNotFoundError,
    ConversationNotFoundError,
    ParticipantNotAdmittedError,
  ],
})
```

App-only conversation mutation surface. `app/conversation/update` owns
archive, unarchive, participant add, and participant remove semantics.

- **Principal:** `AppPrincipal` head + `ConversationInTask`.

### [`ConversationUpdateParams`](./conversations.ts#L133)

_TypeAlias_

```ts
export type ConversationUpdateParams = Schema.Schema.Type<
  typeof ConversationUpdateParamsSchema
>;
```

### [`MessageId`](./types.ts#L30)

_TypeAlias_

```ts
export type MessageId = string & Brand.Brand<"MessageId">;
```

Branded message identifier.

This lives in the conversation module to keep the message module downstream:
conversation participant state references the last-read message, and message
rows reference their conversation.

### [`MessageId`](./types.ts#L30)

_Variable_

```ts
export type MessageId = string & Brand.Brand<"MessageId">
```

### [`NotAParticipantError`](./types.ts#L47)

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

### [`ParticipantNotAdmittedError`](./types.ts#L74)

_Class_

```ts
export class ParticipantNotAdmittedError extends Schema.TaggedError<ParticipantNotAdmittedError>()(
  "ParticipantNotAdmitted",
  errorPayloadFields,
) {
  static readonly message = "Agent is not admitted to the task";
}
```

A requested conversation participant is not admitted to the task that owns
the conversation.

## Files

- `conversations.ts`
- `name.ts`
- `types.ts`
