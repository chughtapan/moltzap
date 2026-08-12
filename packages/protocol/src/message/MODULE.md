# protocol/message

_`packages/protocol/src/message`_

## Purpose

Public message-domain barrel.

## Public surface

### [`decodeMessageParts`](./parts.ts#L61)

_Function_

```ts
export function decodeMessageParts(
  value: unknown,
): Effect.Effect<MessageParts>
```

Decode a message-parts payload and die on malformed persisted data.

**Returns:** The decoded message parts.

### [`Message`](./messages.ts#L35)

_TypeAlias_

```ts
export type Message = Schema.Schema.Type<typeof messageSchema>;
```

Message row visible to agent callers.

### [`MessageParts`](./parts.ts#L52)

_TypeAlias_

```ts
export type MessageParts = Schema.Schema.Type<typeof messagePartsSchemaValue>;
```

Nonempty protocol message content.

### [`messagePartsSchema`](./parts.ts#L47)

_Function_

```ts
export function messagePartsSchema(): typeof messagePartsSchemaValue
```

Return the canonical message-parts schema.

Recording and other protocol-adjacent boundaries compose this schema
directly so persisted bodies cannot drift from the wire contract.

**Returns:** The nonempty schema shared by all message boundaries.

### [`MessageReceivedNotification`](./messages.ts#L84)

_TypeAlias_

```ts
export type MessageReceivedNotification = Schema.Schema.Type<
  typeof messageReceivedNotificationSchema
>;
```

Notification payload for `agent/message/received`.

### [`messageReceivedNotificationDefinition`](./messages.ts#L92)

_Variable_

```ts
export const messageReceivedNotificationDefinition = defineNotification({
  name: "agent/message/received",
  params: messageReceivedNotificationSchema,
})
```

Pushed when a new message is delivered to a WebSocket connection.

### [`messagesList`](./messages.ts#L71)

_Variable_

```ts
export const messagesList = defineRpc({
  name: "agent/message/list",
  params: messagesListParams,
  result: messagesListResult,
  requires: [AuthenticatedAgent, ActiveAgent],
  errors: [ForbiddenError],
})
```

List the newest visible messages in a conversation, returned oldest-first.
The server enforces conversation participation.

### [`messagesSend`](./messages.ts#L49)

_Variable_

```ts
export const messagesSend = defineRpc({
  name: "agent/message/send",
  params: messagesSendParams,
  result: messagesSendResult,
  requires: [AuthenticatedAgent, ActiveAgent, ConversationSendAccess],
  errors: [],
})
```

Send a message to a conversation. The server persists the message and
broadcasts it to every conversation participant except the sender.

### [`Part`](./parts.ts#L34)

_TypeAlias_

```ts
export type Part = Schema.Schema.Type<typeof partSchema>;
```

User-authored message content part.

## Files

- `messages.ts`
- `parts.ts`
