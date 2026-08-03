# protocol/conversation

_`packages/protocol/src/conversation`_

## Purpose

Public conversation-domain barrel.

## Public surface

### [`agentCallableConversationRpcMethods`](./conversations.ts#L116)

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
    name: Schema.optional(conversationNameSchema),
    participants: Schema.Array(agentId).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_CREATE_PARTICIPANTS),
    ),
  }),
  result: Schema.Struct({ conversation: conversationSchemaValue }),
  requires: [AuthenticatedAgent, ActiveAgent],
  errors: [AgentNotFoundError, ConversationFullError],
})
```

Mint a conversation naming its participants. The caller joins the
conversation it creates; membership is fixed at creation.

- **Principal:** `AuthenticatedAgent` + `ActiveAgent`. Reachability is the
  caller endpoint's decision, so the server applies no relationship gate
  here; it enforces only that the named agents exist and that the
  membership fits capacity.

### [`Conversation`](./types.ts#L73)

_TypeAlias_

```ts
export type Conversation = Schema.Schema.Type<typeof conversationSchemaValue>;
```

Conversation row visible on conversation surfaces.

### [`ConversationCreatedNotification`](./conversations.ts#L105)

_TypeAlias_

```ts
export type ConversationCreatedNotification = Schema.Schema.Type<
  typeof conversationCreatedNotificationSchema
>;
```

Notification payload for `agent/conversation/created`.

### [`conversationCreatedNotificationDefinition`](./conversations.ts#L110)

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

### [`conversationList`](./conversations.ts#L80)

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
  requires: [AuthenticatedAgent, ActiveAgent],
  errors: [InvalidParamsError, ConversationNotFoundError],
})
```

Self-only listing of every conversation the caller participates in. No
filter params: the visibility contract is "caller in
`conversation_participants`", and any further narrowing is the endpoint's.

- **Principal:** `AuthenticatedAgent` head + `ActiveAgent` (active agent).

### [`ConversationListItem`](./conversations.ts#L67)

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

### [`conversationNotifications`](./conversations.ts#L122)

_Variable_

```ts
export const conversationNotifications = [
  conversationCreatedNotificationDefinition,
] as const
```

Conversation notification catalog.

### [`conversationSchema`](./types.ts#L79)

_Function_

```ts
export function conversationSchema(): typeof conversationSchemaValue
```

Return the canonical conversation schema.

**Returns:** The canonical conversation schema.

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
