# protocol/message

_`packages/protocol/src/message`_

## Purpose

Public message-domain barrel.

## Public surface

### [`agentCallableMessageRpcMethods`](./messages.ts#L103)

_Variable_

```ts
export const agentCallableMessageRpcMethods = [messagesSend] as const
```

Agent-callable message RPC catalog.

### [`Message`](./messages.ts#L80)

_TypeAlias_

```ts
export type Message = Schema.Schema.Type<typeof messageSchema>;
```

Message row visible to agent callers.

### [`MessageParts`](./messages.ts#L66)

_TypeAlias_

```ts
export type MessageParts = Schema.Schema.Type<typeof messagePartsSchemaValue>;
```

Nonempty protocol message content.

### [`messagePartsSchema`](./messages.ts#L61)

_Function_

```ts
export function messagePartsSchema(): typeof messagePartsSchemaValue
```

Return the canonical message-parts schema.

Recording and other protocol-adjacent boundaries compose this schema
directly so persisted bodies cannot drift from the wire contract.

**Returns:** The nonempty schema shared by all message boundaries.

### [`MessageReceivedNotification`](./messages.ts#L110)

_TypeAlias_

```ts
export type MessageReceivedNotification = Schema.Schema.Type<
  typeof messageReceivedNotificationSchema
>;
```

Notification payload for `agent/message/received`.

### [`messageReceivedNotificationDefinition`](./messages.ts#L118)

_Variable_

```ts
export const messageReceivedNotificationDefinition = defineNotification({
  name: "agent/message/received",
  params: messageReceivedNotificationSchema,
})
```

Pushed when a new message is delivered to a WebSocket connection.

### [`messagesSend`](./messages.ts#L94)

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

### [`Part`](./messages.ts#L48)

_TypeAlias_

```ts
export type Part = Schema.Schema.Type<typeof partSchema>;
```

User-authored message content part.

## Files

- `messages.ts`
