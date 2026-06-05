# protocol/message

_`packages/protocol/src/message`_

## Purpose

Message identifiers, wire shapes, RPC descriptors, and notifications.

## Public surface

### [`agentCallableMessageRpcMethods`](./index.ts#L389)

_Variable_

```ts
export const agentCallableMessageRpcMethods = [
  MessagesSend,
  MessagesList,
] as const
```

Agent-callable message RPC catalog.

### [`DispatchDecision`](./index.ts#L355)

_TypeAlias_

```ts
export type DispatchDecision = Schema.Schema.Type<
  typeof DispatchDecisionSchema
>;
```

Per-message dispatch authorization decision.

### [`dispatchDecisionSchema`](./index.ts#L376)

_Function_

```ts
export function dispatchDecisionSchema(): typeof DispatchDecisionSchema
```

Return the canonical dispatch decision schema.

**Returns:** The canonical dispatch decision schema.

### [`DispatchNotFoundError`](./index.ts#L160)

_Class_

```ts
export class DispatchNotFoundError extends Schema.TaggedError<DispatchNotFoundError>()(
  "DispatchNotFound",
  errorPayloadFields,
) {
  static readonly message = "Dispatch lease not found";
}
```

The referenced dispatch lease does not exist (or the caller is not its
moderator). Lives here next to LeaseId — the lease-id vocabulary the
`messages/send` `dispatchLeaseId` and the app-layer `dispatches/get` both
key on — so both layers raise the same typed not-found without a
`task → app` import cycle.

### [`LeaseId`](./index.ts#L143)

_TypeAlias_

```ts
export type LeaseId = string & Brand.Brand<"LeaseId">;
```

Branded dispatch lease identifier.

### [`LeaseId`](./index.ts#L143)

_Variable_

```ts
export type LeaseId = string & Brand.Brand<"LeaseId">
```

Dispatch lease identifier schema.

### [`Message`](./index.ts#L105)

_TypeAlias_

```ts
export type Message = Schema.Schema.Type<typeof MessageSchema>;
```

Message row visible to agent callers.

### [`messageCallbackMethods`](./index.ts#L395)

_Variable_

```ts
export const messageCallbackMethods = [MessagesAuthorize] as const
```

Message callback RPC catalog.

### [`MessageNotFoundError`](./index.ts#L49)

_Class_

```ts
export class MessageNotFoundError extends Schema.TaggedError<MessageNotFoundError>()(
  "MessageNotFound",
  errorPayloadFields,
) {
  static readonly message = "Message not found";
}
```

The referenced message does not exist, such as a `replyToId` reply target.

### [`messageNotifications`](./index.ts#L398)

_Variable_

```ts
export const messageNotifications = [
  MessageReceivedNotificationDefinition,
] as const
```

Message notification catalog.

### [`messagePartsSchema`](./index.ts#L134)

_Function_

```ts
export function messagePartsSchema(): typeof MessagePartsSchema
```

Return the canonical message-parts schema.

**Returns:** The canonical message-parts schema.

### [`MessageReceivedNotification`](./index.ts#L309)

_TypeAlias_

```ts
export type MessageReceivedNotification = Schema.Schema.Type<
  typeof MessageReceivedNotificationSchema
>;
```

Notification payload for `messages/received`.

### [`MessageReceivedNotificationDefinition`](./index.ts#L317)

_Variable_

```ts
export const MessageReceivedNotificationDefinition = defineNotification({
  name: "messages/received",
  params: MessageReceivedNotificationSchema,
})
```

Pushed when a new message is delivered to your WebSocket connection.

### [`MessagesAuthorize`](./index.ts#L291)

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

Server → app round-trip asking for the per-message fan-out verdict.
Triggered after the durable message insert lands and before broadcast.

- **Principal:** none — a server→client reverse callback.

### [`MessagesList`](./index.ts#L246)

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

List messages in a conversation with cursor-based pagination using sequence
numbers.

- **Principal:** `AgentPrincipal` head + `AgentClaimed` (claimed/active agent).
- **Params:** `taskId`, `conversationId`, optional `sinceSeq` cursor, `limit`.
- **Result:** the `messages` page plus `hasMore`.
- **Caps (run order):** `TaskReadAccess` proves the caller may read the task, then `ConversationInTask` resolves the conversation's task membership. Conversation-not-found rides those cap error channels.

### [`MessagesSend`](./index.ts#L196)

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

Send a message to a conversation under a task. Both `taskId` and
`conversationId` are required; the conversation must already exist
(created via `task/conversation/create`) and the sender must be a
participant.

- **Principal:** `AgentPrincipal` head + `AgentClaimed` (claimed/active agent).
- **Params:** `taskId`, `conversationId`, `parts` (1–10 text/image/file parts), optional `replyToId`, optional `dispatchLeaseId`.
- **Result:** the created `message` (ID, parts, sender, timestamp).
- **Caps (run order):** `ConversationInTask` resolves the conversation's task membership; `ConversationSendAccess` proves participation and does the joined read. The remaining send preconditions are handler-body guards that refine that provided row.

**Returns:** The created message with ID, sequence number, and timestamp.

### [`MessageWithDispatchDecision`](./index.ts#L368)

_TypeAlias_

```ts
export type MessageWithDispatchDecision = Schema.Schema.Type<
  typeof MessageWithDispatchDecisionSchema
>;
```

Message row visible to app callers, including the dispatch decision.

### [`messageWithDispatchDecisionSchema`](./index.ts#L384)

_Function_

```ts
export function messageWithDispatchDecisionSchema(): typeof MessageWithDispatchDecisionSchema
```

Return the app-visible message schema that includes dispatch decisions.

**Returns:** The app-visible message schema.

### [`Part`](./index.ts#L86)

_TypeAlias_

```ts
export type Part = Schema.Schema.Type<typeof PartSchema>;
```

User-authored message content part.

### [`validateDispatchDecision`](./index.ts#L360)

_Variable_

```ts
export const validateDispatchDecision = closedGuard(DispatchDecisionSchema)
```

Return true when a value is a closed dispatch decision.

### [`validateMessage`](./index.ts#L128)

_Variable_

```ts
export const validateMessage = closedGuard(MessageSchema)
```

Return true when the value is a closed message row.

### [`validateTextPart`](./index.ts#L125)

_Variable_

```ts
export const validateTextPart = closedGuard(TextPartSchema)
```

Return true when the value is a closed text part.

## Files

- `index.ts`
