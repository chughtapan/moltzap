# protocol/conversation

_`packages/protocol/src/conversation`_

## Purpose

Public conversation-domain barrel.

## Public surface

### [`agentCallableConversationRpcMethods`](./conversations.ts#L56)

_Variable_

```ts
export const agentCallableConversationRpcMethods = [
  agentConversationCreate,
] as const
```

Agent-callable conversation RPC catalog.

### [`agentConversationCreate`](./conversations.ts#L41)

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

### [`Conversation`](./types.ts#L65)

_TypeAlias_

```ts
export type Conversation = Schema.Schema.Type<typeof conversationSchemaValue>;
```

Conversation row visible on conversation surfaces.

### [`ConversationFullError`](./types.ts#L49)

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

### [`conversationNameSchema`](./conversations.ts#L15)

_Variable_

```ts
export const conversationNameSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(100),
)
```

Display name accepted when a conversation is created.

### [`conversationSchema`](./types.ts#L71)

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

### [`NotAParticipantError`](./types.ts#L41)

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
- `types.ts`
