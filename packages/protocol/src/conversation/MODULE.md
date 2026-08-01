# protocol/conversation

_`packages/protocol/src/conversation`_

## Purpose

Public conversation-domain barrel.

## Public surface

### [`agentCallableConversationRpcMethods`](./conversations.ts#L190)

_Variable_

```ts
export const agentCallableConversationRpcMethods = [
  conversationList,
  agentConversationCreate,
] as const
```

Agent-callable conversation RPC catalog.

### [`agentConversationCreate`](./conversations.ts#L43)

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

### [`appCallableConversationRpcMethods`](./conversations.ts#L196)

_Variable_

```ts
export const appCallableConversationRpcMethods = [conversationUpdate] as const
```

App-callable conversation RPC catalog.

### [`Conversation`](./types.ts#L73)

_TypeAlias_

```ts
export type Conversation = Schema.Schema.Type<typeof conversationSchemaValue>;
```

Conversation row visible on conversation surfaces.

### [`ConversationCreatedNotification`](./conversations.ts#L155)

_TypeAlias_

```ts
export type ConversationCreatedNotification = Schema.Schema.Type<
  typeof conversationCreatedNotificationSchema
>;
```

Notification payload for `agent/conversation/created`.

### [`conversationCreatedNotificationDefinition`](./conversations.ts#L170)

_Variable_

```ts
export const conversationCreatedNotificationDefinition = defineNotification({
  name: "agent/conversation/created",
  params: conversationCreatedNotificationSchema,
})
```

Pushed when a conversation is created.

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

### [`conversationList`](./conversations.ts#L78)

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

Self-only listing of every conversation the caller participates in. No
filter params: the visibility contract is "caller in
`conversation_participants`", and any further narrowing is the endpoint's.

- **Principal:** `AgentPrincipal` head + `ActiveAgent` (active agent).

### [`ConversationListItem`](./conversations.ts#L65)

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

The referenced conversation does not exist (or is not visible to the caller).

### [`conversationNotifications`](./conversations.ts#L199)

_Variable_

```ts
export const conversationNotifications = [
  conversationCreatedNotificationDefinition,
  conversationParticipantsAddedNotificationDefinition,
  conversationParticipantsRemovedNotificationDefinition,
] as const
```

Conversation notification catalog.

### [`ConversationParticipantsAddedNotification`](./conversations.ts#L160)

_TypeAlias_

```ts
export type ConversationParticipantsAddedNotification = Schema.Schema.Type<
  typeof conversationParticipantsAddedNotificationSchema
>;
```

Notification payload for `agent/conversation/participants-added`.

### [`conversationParticipantsAddedNotificationDefinition`](./conversations.ts#L176)

_Variable_

```ts
export const conversationParticipantsAddedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/participants-added",
    params: conversationParticipantsAddedNotificationSchema,
  })
```

Pushed when a participant is added to a conversation.

### [`ConversationParticipantsRemovedNotification`](./conversations.ts#L165)

_TypeAlias_

```ts
export type ConversationParticipantsRemovedNotification = Schema.Schema.Type<
  typeof conversationParticipantsRemovedNotificationSchema
>;
```

Notification payload for `agent/conversation/participants-removed`.

### [`conversationParticipantsRemovedNotificationDefinition`](./conversations.ts#L183)

_Variable_

```ts
export const conversationParticipantsRemovedNotificationDefinition =
  defineNotification({
    name: "agent/conversation/participants-removed",
    params: conversationParticipantsRemovedNotificationSchema,
  })
```

Pushed when a participant is removed from a conversation.

### [`conversationSchema`](./types.ts#L79)

_Function_

```ts
export function conversationSchema(): typeof conversationSchemaValue
```

Return the canonical conversation schema.

**Returns:** The canonical conversation schema.

### [`conversationUpdate`](./conversations.ts#L119)

_Variable_

```ts
export const conversationUpdate = defineRpc({
  name: "app/conversation/update",
  params: conversationUpdateParamsSchema,
  result: Schema.Struct({}),
  requires: [AppPrincipal],
  errors: [ForbiddenError, ConversationNotFoundError, ConversationFullError],
})
```

App-only conversation mutation surface. `app/conversation/update` owns
participant add and participant remove semantics.

- **Principal:** `AppPrincipal` head.

### [`ConversationUpdateParams`](./conversations.ts#L106)

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
message rows reference their conversation, so the identifier both domains
share belongs to the one they both sit above.

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

## Files

- `conversations.ts`
- `name.ts`
- `types.ts`
