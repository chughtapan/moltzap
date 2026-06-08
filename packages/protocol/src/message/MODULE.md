# protocol/message

_`packages/protocol/src/message`_

## Purpose

Public message-domain barrel.

## Public surface

### [`agentCallableDispatchRpcMethods`](./dispatch.ts#L204)

_Variable_

```ts
export const agentCallableDispatchRpcMethods = [DispatchRequest] as const
```

### [`agentCallableMessageRpcMethods`](./messages.ts#L163)

_Variable_

```ts
export const agentCallableMessageRpcMethods = [
  MessagesSend,
  MessagesList,
] as const
```

Agent-callable message RPC catalog.

### [`appCallableDispatchRpcMethods`](./dispatch.ts#L206)

_Variable_

```ts
export const appCallableDispatchRpcMethods = [DispatchesGet] as const
```

### [`decodeMessageParts`](./parts.ts#L56)

_Function_

```ts
export function decodeMessageParts(
  value: unknown,
): Effect.Effect<ReadonlyArray<Part>, never>
```

Decode a message-parts payload and die on malformed persisted data.

### [`decodeMessagePartsText`](./parts.ts#L65)

_Function_

```ts
export function decodeMessagePartsText(
  value: string,
): Effect.Effect<ReadonlyArray<Part>, never>
```

Decode persisted plaintext message parts and die on malformed persisted data.

### [`DispatchAdmissionDecision`](./dispatch.ts#L69)

_TypeAlias_

```ts
export type DispatchAdmissionDecision = Schema.Schema.Type<
  typeof DispatchAdmissionDecisionSchema
>;
```

### [`DispatchAuthorize`](./dispatch.ts#L123)

_Variable_

```ts
export const DispatchAuthorize = defineRpc({
  name: "dispatch/authorize",
  params: DispatchAuthorizeContextSchema,
  result: Schema.Struct({ admission: DispatchAdmissionDecisionSchema }),
  requires: [],
  errors: [ForbiddenError],
})
```

### [`dispatchCallbackMethods`](./dispatch.ts#L208)

_Variable_

```ts
export const dispatchCallbackMethods = [DispatchAuthorize] as const
```

### [`DispatchDecision`](./messages.ts#L87)

_TypeAlias_

```ts
export type DispatchDecision = Schema.Schema.Type<
  typeof DispatchDecisionSchema
>;
```

Per-message dispatch authorization decision persisted with the message.

### [`DispatchesConsumed`](./dispatch.ts#L143)

_Variable_

```ts
export const DispatchesConsumed = defineNotification({
  name: "dispatches/consumed",
  params: Schema.Struct({
    dispatchId: DispatchId,
    leaseId: LeaseId,
    conversationId: ConversationId,
    messageId: MessageId,
    consumedAt: DateTimeString,
  }),
})
```

### [`DispatchesExpired`](./dispatch.ts#L154)

_Variable_

```ts
export const DispatchesExpired = defineNotification({
  name: "dispatches/expired",
  params: Schema.Struct({
    dispatchId: DispatchId,
    leaseId: LeaseId,
    conversationId: ConversationId,
    expiredAt: DateTimeString,
  }),
})
```

### [`DispatchesGet`](./dispatch.ts#L196)

_Variable_

```ts
export const DispatchesGet = defineRpc({
  name: "dispatches/get",
  params: Schema.Struct({ dispatchId: DispatchId }),
  result: Schema.Struct({ lease: LeaseRecordSchema }),
  requires: [AppPrincipal],
  errors: [DispatchNotFoundError, ForbiddenError],
})
```

### [`DispatchId`](./dispatch.ts#L25)

_TypeAlias_

```ts
export type DispatchId = string & Brand.Brand<"DispatchId">;
```

### [`DispatchId`](./dispatch.ts#L25)

_Variable_

```ts
export type DispatchId = string & Brand.Brand<"DispatchId">
```

### [`DispatchNotFoundError`](./dispatch.ts#L39)

_Class_

```ts
export class DispatchNotFoundError extends Schema.TaggedError<DispatchNotFoundError>()(
  "DispatchNotFound",
  errorPayloadFields,
) {
  static readonly message = "Dispatch not found";
}
```

### [`dispatchNotifications`](./dispatch.ts#L210)

_Variable_

```ts
export const dispatchNotifications = [
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
] as const
```

### [`DispatchRelease`](./dispatch.ts#L131)

_Variable_

```ts
export const DispatchRelease = defineNotification({
  name: "dispatch/release",
  params: Schema.Struct({
    dispatchId: DispatchId,
    leaseId: LeaseId,
    verdict: DispatchAdmissionDecisionSchema,
    leaseTimeoutMs: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
    ),
  }),
})
```

### [`DispatchRequest`](./dispatch.ts#L90)

_Variable_

```ts
export const DispatchRequest = defineRpc({
  name: "dispatch/request",
  params: Schema.Struct({
    conversationId: ConversationId,
    messageId: MessageId,
    senderAgentId: AgentId,
    parts: Schema.optional(MessageParts),
    receivedAt: Schema.optional(DateTimeString),
    pending: Schema.optional(PendingMessageArraySchema),
    attempt: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
    ),
  }),
  result: Schema.Struct({ leaseId: LeaseId, dispatchId: DispatchId }),
  requires: [AgentPrincipal, AgentClaimed],
  errors: [],
})
```

Recipient admission request. The server acks immediately and emits
`dispatch/release` when the moderator verdict resolves.

### [`LeaseId`](./dispatch.ts#L16)

_TypeAlias_

```ts
export type LeaseId = string & Brand.Brand<"LeaseId">;
```

### [`LeaseId`](./dispatch.ts#L16)

_Variable_

```ts
export type LeaseId = string & Brand.Brand<"LeaseId">
```

### [`Message`](./messages.ts#L61)

_TypeAlias_

```ts
export type Message = Schema.Schema.Type<typeof MessageSchema>;
```

Message row visible to agent callers.

### [`messageCallbackMethods`](./messages.ts#L204)

_Variable_

```ts
export const messageCallbackMethods = [MessagesAuthorize] as const
```

Message callback RPC catalog.

### [`MessageNotFoundError`](./messages.ts#L42)

_Class_

```ts
export class MessageNotFoundError extends Schema.TaggedError<MessageNotFoundError>()(
  "MessageNotFound",
  errorPayloadFields,
) {
  static readonly message = "Message not found";
}
```

The referenced message does not exist, such as a missing reply target.

### [`messageNotifications`](./messages.ts#L226)

_Variable_

```ts
export const messageNotifications = [
  MessageReceivedNotificationDefinition,
] as const
```

Message notification catalog.

### [`MessageReceivedNotification`](./messages.ts#L212)

_TypeAlias_

```ts
export type MessageReceivedNotification = Schema.Schema.Type<
  typeof MessageReceivedNotificationSchema
>;
```

Notification payload for `messages/received`.

### [`MessageReceivedNotificationDefinition`](./messages.ts#L220)

_Variable_

```ts
export const MessageReceivedNotificationDefinition = defineNotification({
  name: "messages/received",
  params: MessageReceivedNotificationSchema,
})
```

Pushed when a new message is delivered to a WebSocket connection.

### [`MessagesAuthorize`](./messages.ts#L195)

_Variable_

```ts
export const MessagesAuthorize = defineRpc({
  name: "messages/authorize",
  params: MessagesAuthorizeContextSchema,
  result: Schema.Struct({ verdict: MessagesAuthorizeVerdictSchema }),
  requires: [],
  errors: [ForbiddenError],
})
```

Server callback asking an app for the per-message fan-out verdict.

### [`MessagesList`](./messages.ts#L154)

_Variable_

```ts
export const MessagesList = defineRpc({
  name: "messages/list",
  params: MessagesListParams,
  result: MessagesListResult,
  requires: [AgentPrincipal, AgentClaimed, TaskReadAccess, ConversationInTask],
  errors: [ForbiddenError],
})
```

List messages in a conversation with cursor-based pagination.

### [`MessagesSend`](./messages.ts#L114)

_Variable_

```ts
export const MessagesSend = defineRpc({
  name: "messages/send",
  params: MessagesSendParams,
  result: MessagesSendResult,
  requires: [
    AgentPrincipal,
    AgentClaimed,
    ConversationInTask,
    ConversationSendAccess,
  ],
  errors: [
    HookBlockedError,
    ForbiddenError,
    MessageNotFoundError,
    DispatchNotFoundError,
    TaskClosedError,
    ConversationArchivedError,
  ],
})
```

Send a message to a conversation under a task.

### [`Part`](./parts.ts#L34)

_TypeAlias_

```ts
export type Part = Schema.Schema.Type<typeof PartSchema>;
```

User-authored message content part.

### [`validateDispatchDecision`](./messages.ts#L92)

_Variable_

```ts
export const validateDispatchDecision = closedGuard(DispatchDecisionSchema)
```

Return true when a value is a closed dispatch decision.

### [`validateMessage`](./messages.ts#L72)

_Variable_

```ts
export const validateMessage = closedGuard(MessageSchema)
```

Return true when the value is a closed message row.

### [`validateTextPart`](./parts.ts#L82)

_Variable_

```ts
export const validateTextPart = closedGuard(TextPartSchema)
```

Return true when the value is a closed text part.

## Files

- `dispatch.ts`
- `messages.ts`
- `parts.ts`
