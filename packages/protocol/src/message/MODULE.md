# protocol/message

_`packages/protocol/src/message`_

## Purpose

Public message-domain barrel.

## Public surface

### [`agentCallableDispatchRpcMethods`](./dispatch.ts#L212)

_Variable_

```ts
export const agentCallableDispatchRpcMethods = [dispatchRequest] as const
```

Lists the agent callable dispatch rpc methods in dispatch order.

### [`agentCallableMessageRpcMethods`](./messages.ts#L142)

_Variable_

```ts
export const agentCallableMessageRpcMethods = [
  messagesSend,
  messagesList,
] as const
```

Agent-callable message RPC catalog.

### [`appCallableDispatchRpcMethods`](./dispatch.ts#L215)

_Variable_

```ts
export const appCallableDispatchRpcMethods = [dispatchLeaseGet] as const
```

Lists the app callable dispatch rpc methods in dispatch order.

### [`decodeMessageParts`](./parts.ts#L65)

_Function_

```ts
export function decodeMessageParts(
  value: unknown,
): Effect.Effect<MessageParts>
```

Decode a message-parts payload and die on malformed persisted data.

**Returns:** The decoded message parts.

### [`decodeMessagePartsText`](./parts.ts#L78)

_Function_

```ts
export function decodeMessagePartsText(
  value: string,
): Effect.Effect<MessageParts>
```

Decode persisted plaintext message parts and die on malformed persisted data.

**Returns:** The decoded message parts text.

### [`DispatchAdmissionDecision`](./dispatch.ts#L71)

_TypeAlias_

```ts
export type DispatchAdmissionDecision = Schema.Schema.Type<
  typeof dispatchAdmissionDecisionSchema
>;
```

Represents dispatch admission decision values.

### [`dispatchAuthorize`](./dispatch.ts#L126)

_Variable_

```ts
export const dispatchAuthorize = defineRpc({
  name: "app/dispatch/authorize",
  params: dispatchAuthorizeContextSchema,
  result: Schema.Struct({ admission: dispatchAdmissionDecisionSchema }),
  requires: [],
  errors: [ForbiddenError],
})
```

Defines the `app/dispatch/authorize` RPC contract.

### [`dispatchCallbackMethods`](./dispatch.ts#L218)

_Variable_

```ts
export const dispatchCallbackMethods = [dispatchAuthorize] as const
```

Lists the dispatch callback methods in dispatch order.

### [`DispatchDecision`](./messages.ts#L67)

_TypeAlias_

```ts
export type DispatchDecision = Schema.Schema.Type<
  typeof dispatchDecisionSchemaValue
>;
```

Per-message dispatch authorization decision persisted with the message.

### [`dispatchDecisionSchema`](./messages.ts#L75)

_Function_

```ts
export function dispatchDecisionSchema(): typeof dispatchDecisionSchemaValue
```

Return the canonical persisted dispatch-authorization schema.

**Returns:** A schema shared by storage and wire validation.

### [`dispatchId`](./dispatch.ts#L32)

_Variable_

```ts
export const dispatchId: Schema.Schema<DispatchId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("DispatchId"),
  Schema.annotations({ description: "Branded DispatchId" }),
)
```

Validates and decodes dispatch id values.

### [`DispatchId`](./dispatch.ts#L29)

_TypeAlias_

```ts
export type DispatchId = string & Brand.Brand<"DispatchId">;
```

Represents dispatch id values.

### [`dispatchLeaseConsumed`](./dispatch.ts#L148)

_Variable_

```ts
export const dispatchLeaseConsumed = defineNotification({
  name: "app/dispatch/lease-consumed",
  params: Schema.Struct({
    dispatchId: dispatchId,
    leaseId: leaseId,
    conversationId: conversationId,
    messageId: messageId,
    consumedAt: dateTimeString,
  }),
})
```

Defines the `app/dispatch/lease-consumed` notification contract.

### [`dispatchLeaseExpired`](./dispatch.ts#L160)

_Variable_

```ts
export const dispatchLeaseExpired = defineNotification({
  name: "app/dispatch/lease-expired",
  params: Schema.Struct({
    dispatchId: dispatchId,
    leaseId: leaseId,
    conversationId: conversationId,
    expiredAt: dateTimeString,
  }),
})
```

Defines the `app/dispatch/lease-expired` notification contract.

### [`dispatchLeaseGet`](./dispatch.ts#L203)

_Variable_

```ts
export const dispatchLeaseGet = defineRpc({
  name: "app/dispatch/lease/get",
  params: Schema.Struct({ dispatchId: dispatchId }),
  result: Schema.Struct({ lease: leaseRecordSchema }),
  requires: [AppPrincipal],
  errors: [DispatchNotFoundError, ForbiddenError],
})
```

Defines the `app/dispatch/lease/get` RPC contract.

### [`DispatchNotFoundError`](./dispatch.ts#L40)

_Class_

```ts
export class DispatchNotFoundError extends Schema.TaggedError<DispatchNotFoundError>()(
  "DispatchNotFound",
  errorPayloadFields,
) {
  static readonly message = "Dispatch not found";
}
```

Reports dispatch not found failures.

### [`dispatchNotifications`](./dispatch.ts#L221)

_Variable_

```ts
export const dispatchNotifications = [
  dispatchRelease,
  dispatchLeaseConsumed,
  dispatchLeaseExpired,
] as const
```

Lists the dispatch notification definitions.

### [`dispatchRelease`](./dispatch.ts#L135)

_Variable_

```ts
export const dispatchRelease = defineNotification({
  name: "agent/dispatch/released",
  params: Schema.Struct({
    dispatchId: dispatchId,
    leaseId: leaseId,
    verdict: dispatchAdmissionDecisionSchema,
    leaseTimeoutMs: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
    ),
  }),
})
```

Defines the `agent/dispatch/released` notification contract.

### [`dispatchRequest`](./dispatch.ts#L92)

_Variable_

```ts
export const dispatchRequest = defineRpc({
  name: "agent/dispatch/request",
  params: Schema.Struct({
    conversationId: conversationId,
    messageId: messageId,
    senderAgentId: agentId,
    parts: Schema.optional(messageParts),
    receivedAt: Schema.optional(dateTimeString),
    pending: Schema.optional(pendingMessageArraySchema),
    attempt: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
    ),
  }),
  result: Schema.Struct({ leaseId: leaseId, dispatchId: dispatchId }),
  requires: [AgentPrincipal, ActiveAgent],
  errors: [],
})
```

Recipient admission request. The server acks immediately and emits
`agent/dispatch/released` when the moderator verdict resolves.

### [`leaseId`](./dispatch.ts#L21)

_Variable_

```ts
export const leaseId: Schema.Schema<LeaseId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("LeaseId"),
  Schema.annotations({ description: "Branded LeaseId" }),
)
```

Validates and decodes lease id values.

### [`LeaseId`](./dispatch.ts#L18)

_TypeAlias_

```ts
export type LeaseId = string & Brand.Brand<"LeaseId">;
```

Represents lease id values.

### [`Message`](./messages.ts#L49)

_TypeAlias_

```ts
export type Message = Schema.Schema.Type<typeof messageSchema>;
```

Message row visible to agent callers.

### [`messageCallbackMethods`](./messages.ts#L183)

_Variable_

```ts
export const messageCallbackMethods = [messagesAuthorize] as const
```

Message callback RPC catalog.

### [`messageNotifications`](./messages.ts#L205)

_Variable_

```ts
export const messageNotifications = [
  messageReceivedNotificationDefinition,
] as const
```

Message notification catalog.

### [`MessageParts`](./parts.ts#L53)

_TypeAlias_

```ts
export type MessageParts = Schema.Schema.Type<typeof messagePartsSchemaValue>;
```

Nonempty protocol message content.

### [`messagePartsSchema`](./parts.ts#L48)

_Function_

```ts
export function messagePartsSchema(): typeof messagePartsSchemaValue
```

Return the canonical message-parts schema.

Recording and other protocol-adjacent boundaries compose this schema
directly so persisted bodies cannot drift from the wire contract.

**Returns:** The nonempty schema shared by all message boundaries.

### [`MessageReceivedNotification`](./messages.ts#L191)

_TypeAlias_

```ts
export type MessageReceivedNotification = Schema.Schema.Type<
  typeof messageReceivedNotificationSchema
>;
```

Notification payload for `agent/message/received`.

### [`messageReceivedNotificationDefinition`](./messages.ts#L199)

_Variable_

```ts
export const messageReceivedNotificationDefinition = defineNotification({
  name: "agent/message/received",
  params: messageReceivedNotificationSchema,
})
```

Pushed when a new message is delivered to a WebSocket connection.

### [`messagesAuthorize`](./messages.ts#L174)

_Variable_

```ts
export const messagesAuthorize = defineRpc({
  name: "app/message/authorize",
  params: messagesAuthorizeContextSchema,
  result: Schema.Struct({ verdict: messagesAuthorizeVerdictSchema }),
  requires: [],
  errors: [ForbiddenError],
})
```

Server callback asking an app for the per-message fan-out verdict.

### [`messagesList`](./messages.ts#L133)

_Variable_

```ts
export const messagesList = defineRpc({
  name: "agent/message/list",
  params: messagesListParams,
  result: messagesListResult,
  requires: [AgentPrincipal, ActiveAgent, TaskReadAccess, ConversationInTask],
  errors: [ForbiddenError],
})
```

List the newest visible messages in a conversation, returned oldest-first.

### [`messagesSend`](./messages.ts#L101)

_Variable_

```ts
export const messagesSend = defineRpc({
  name: "agent/message/send",
  params: messagesSendParams,
  result: messagesSendResult,
  requires: [
    AgentPrincipal,
    ActiveAgent,
    ConversationInTask,
    ConversationSendAccess,
  ],
  errors: [
    HookBlockedError,
    ForbiddenError,
    DispatchNotFoundError,
    TaskClosedError,
  ],
})
```

Send a message to a conversation under a task.

### [`Part`](./parts.ts#L34)

_TypeAlias_

```ts
export type Part = Schema.Schema.Type<typeof partSchema>;
```

User-authored message content part.

### [`validateDispatchDecision`](./messages.ts#L80)

_Variable_

```ts
export const validateDispatchDecision = closedStructGuard(
  dispatchDecisionSchemaValue,
)
```

Return true when a value is a closed dispatch decision.

### [`validateMessage`](./messages.ts#L52)

_Variable_

```ts
export const validateMessage = closedStructGuard(messageSchema)
```

Return true when the value is a closed message row.

### [`validateTextPart`](./parts.ts#L87)

_Variable_

```ts
export const validateTextPart = closedStructGuard(textPartSchema)
```

Return true when the value is a closed text part.

## Files

- `dispatch.ts`
- `messages.ts`
- `parts.ts`
