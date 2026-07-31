# protocol/conversation

_`packages/protocol/src/conversation`_

## Purpose

Public conversation-domain barrel.

## Public surface

### [`agentCallableConversationRpcMethods`](./conversations.ts#L246)

_Variable_

```ts
export const agentCallableConversationRpcMethods = [
  conversationList,
  agentConversationCreate,
] as const
```

Agent-callable conversation RPC catalog.

### [`agentConversationCreate`](./conversations.ts#L47)

_Variable_

```ts
export const agentConversationCreate = defineRpc({
  name: "agent/conversation/create",
  params: Schema.Struct({
    appId: appId,
    name: Schema.optional(conversationNameSchema),
    participants: Schema.Array(agentId).pipe(Schema.minItems(1)),
  }),
  result: Schema.Struct({ conversation: conversationSchemaValue }),
  requires: [AgentPrincipal, ActiveAgent],
  errors: [AgentNotFoundError, ConversationFullError],
})
```

Mint a conversation naming its participants and the app that authorizes
it. The caller joins the conversation it creates.

- **Principal:** `AgentPrincipal` + `ActiveAgent`. Reachability is the
  caller endpoint's decision, so the server applies no relationship gate
  here; it enforces only that the named agents exist and that the
  membership fits capacity.

### [`appCallableConversationRpcMethods`](./conversations.ts#L252)

_Variable_

```ts
export const appCallableConversationRpcMethods = [
  conversationCreate,
  conversationUpdate,
] as const
```

App-callable conversation RPC catalog.

### [`Conversation`](./types.ts#L85)

_TypeAlias_

```ts
export type Conversation = Schema.Schema.Type<typeof conversationSchemaValue>;
```

Conversation row visible on task conversation surfaces.

### [`conversationCreate`](./conversations.ts#L79)

_Variable_

```ts
export const conversationCreate = defineRpc({
  name: "app/conversation/create",
  params: Schema.Struct({
    taskId: taskId,
    name: Schema.optional(conversationNameSchema),
    participants: Schema.Array(agentId).pipe(Schema.minItems(1)),
  }),
  result: Schema.Struct({ conversation: conversationSchemaValue }),
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
  authorization inline, and targets are gated by
  `requireAgentsAreInTaskParticipants`.

### [`ConversationCreatedNotification`](./conversations.ts#L211)

_TypeAlias_

```ts
export type ConversationCreatedNotification = Schema.Schema.Type<
  typeof conversationCreatedNotificationSchema
>;
```

Notification payload for `agent/conversation/created`.

### [`conversationCreatedNotificationDefinition`](./conversations.ts#L226)

_Variable_

```ts
export const conversationCreatedNotificationDefinition = defineNotification({
  name: "agent/conversation/created",
  params: conversationCreatedNotificationSchema,
})
```

Pushed when a task conversation is created.

### [`ConversationFullError`](./types.ts#L57)

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

### [`conversationId`](./types.ts#L18)

_Variable_

```ts
export const conversationId: Schema.Schema<ConversationId, string> =
  formatString("uuid").pipe(
    Schema.brand("ConversationId"),
    Schema.annotations({ description: "Branded ConversationId" }),
  )
```

Validates and decodes conversation id values.

### [`ConversationId`](./types.ts#L16)

_TypeAlias_

```ts
export type ConversationId = string & Brand.Brand<"ConversationId">;
```

Branded conversation identifier.

### [`conversationList`](./conversations.ts#L121)

_Variable_

```ts
export const conversationList = defineRpc({
  name: "agent/conversation/list",
  params: Schema.Struct({
    limit: listLimitSchema,
    cursor: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({
    items: Schema.Array(conversationListItemSchema),
    nextCursor: Schema.optional(Schema.String),
  }),
  requires: [AgentPrincipal, ActiveAgent],
  errors: [InvalidParamsError, ConversationNotFoundError],
})
```

Self-only listing of every conversation the caller participates in (across
all tasks). No filter params: the visibility contract is "caller in
`conversation_participants`", and any further narrowing is the endpoint's.

- **Principal:** `AgentPrincipal` head + `ActiveAgent` (active agent).

### [`ConversationListItem`](./conversations.ts#L108)

_TypeAlias_

```ts
export type ConversationListItem = Schema.Schema.Type<
  typeof conversationListItemSchema
>;
```

Conversation list item returned by `agent/conversation/list`.

### [`conversationNameSchema`](./name.ts#L5)

_Variable_

```ts
export const conversationNameSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(100),
)
```

Display name accepted when a conversation is created.

### [`ConversationNotFoundError`](./types.ts#L41)

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

### [`conversationNotifications`](./conversations.ts#L258)

_Variable_

```ts
export const conversationNotifications = [
  conversationCreatedNotificationDefinition,
  conversationParticipantsAddedNotificationDefinition,
  conversationParticipantsRemovedNotificationDefinition,
] as const
```

Conversation notification catalog.

### [`ConversationParticipant`](./types.ts#L88)

_Interface_

```ts
export interface ConversationParticipant {
  readonly conversationId: ConversationId;
  readonly participant: { readonly type: "agent"; readonly id: string };
  readonly joinedAt: string;
  readonly lastReadMessageId?: MessageId;
  readonly agentName?: string;
  readonly agentDisplayName?: string;
}
```

Participant row for a conversation.

### [`ConversationParticipantsAddedNotification`](./conversations.ts#L216)

_TypeAlias_

```ts
export type ConversationParticipantsAddedNotification = Schema.Schema.Type<
  typeof conversationParticipantsAddedNotificationSchema
>;
```

Notification payload for `agent/conversation/participants-added`.

### [`conversationParticipantsAddedNotificationDefinition`](./conversations.ts#L232)

_Variable_

```ts
export const conversationParticipantsAddedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/participants-added",
    params: conversationParticipantsAddedNotificationSchema,
  })
```

Pushed when a participant is added to a task conversation.

### [`ConversationParticipantsRemovedNotification`](./conversations.ts#L221)

_TypeAlias_

```ts
export type ConversationParticipantsRemovedNotification = Schema.Schema.Type<
  typeof conversationParticipantsRemovedNotificationSchema
>;
```

Notification payload for `agent/conversation/participants-removed`.

### [`conversationParticipantsRemovedNotificationDefinition`](./conversations.ts#L239)

_Variable_

```ts
export const conversationParticipantsRemovedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/participants-removed",
    params: conversationParticipantsRemovedNotificationSchema,
  })
```

Pushed when a participant is removed from a task conversation.

### [`conversationSchema`](./types.ts#L114)

_Function_

```ts
export function conversationSchema(): typeof conversationSchemaValue
```

Return the canonical conversation schema.

**Returns:** The canonical conversation schema.

### [`ConversationSummary`](./types.ts#L98)

_Interface_

```ts
export interface ConversationSummary {
  readonly id: ConversationId;
  readonly name?: string;
  readonly lastMessagePreview?: string;
  readonly lastMessageTimestamp?: string;
  readonly unreadCount: number;
  readonly participants?: ReadonlyArray<{
    readonly type: "agent";
    readonly id: string;
  }>;
}
```

Conversation summary row used by list surfaces.

### [`conversationUpdate`](./conversations.ts#L166)

_Variable_

```ts
export const conversationUpdate = defineRpc({
  name: "app/conversation/update",
  params: conversationUpdateParamsSchema,
  result: Schema.Struct({}),
  requires: [AppPrincipal, ConversationInTask],
  errors: [
    ForbiddenError,
    TaskNotFoundError,
    ConversationNotFoundError,
    ParticipantNotAdmittedError,
    ConversationFullError,
  ],
})
```

App-only conversation mutation surface. `app/conversation/update` owns
participant add and participant remove semantics.

- **Principal:** `AppPrincipal` head + `ConversationInTask`.

### [`ConversationUpdateParams`](./conversations.ts#L151)

_TypeAlias_

```ts
export type ConversationUpdateParams = Schema.Schema.Type<
  typeof conversationUpdateParamsSchema
>;
```

Represents conversation update params values.

### [`messageId`](./types.ts#L33)

_Variable_

```ts
export const messageId: Schema.Schema<MessageId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("MessageId"),
  Schema.annotations({ description: "Branded MessageId" }),
)
```

Validates and decodes message id values.

### [`MessageId`](./types.ts#L31)

_TypeAlias_

```ts
export type MessageId = string & Brand.Brand<"MessageId">;
```

Branded message identifier.

This lives in the conversation module to keep the message module downstream:
conversation participant state references the last-read message, and message
rows reference their conversation.

### [`NotAParticipantError`](./types.ts#L49)

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

### [`ParticipantNotAdmittedError`](./types.ts#L68)

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
