# protocol/message

_`packages/protocol/src/message`_

## Purpose

Message identifiers, wire shapes, RPC descriptors, and notifications.

## Public surface

### [`agentCallableMessageRpcMethods`](./index.ts#L340)

_Variable_

```ts
export const agentCallableMessageRpcMethods = [
  MessagesSend,
  MessagesList,
] as const
```

Agent-callable message RPC catalog.

### [`DispatchDecision`](./index.ts#L306)

_TypeAlias_

```ts
export type DispatchDecision = Schema.Schema.Type<
  typeof DispatchDecisionSchema
>;
```

Per-message dispatch authorization decision.

### [`dispatchDecisionSchema`](./index.ts#L327)

_Function_

```ts
export function dispatchDecisionSchema(): typeof DispatchDecisionSchema
```

Return the canonical dispatch decision schema.

**Returns:** The canonical dispatch decision schema.

### [`DispatchNotFoundError`](./index.ts#L156)

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

### [`LeaseId`](./index.ts#L144)

_TypeAlias_

```ts
export const LeaseId = brandedId("LeaseId");
```

Branded dispatch lease identifier value.

### [`LeaseId`](./index.ts#L144)

_Variable_

```ts
export const LeaseId = brandedId("LeaseId")
```

Branded dispatch lease identifier.

### [`Message`](./index.ts#L106)

_TypeAlias_

```ts
export type Message = Schema.Schema.Type<typeof MessageSchema>;
```

Message row visible to agent callers.

### [`MessageNotFoundError`](./index.ts#L50)

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

### [`messageNotifications`](./index.ts#L346)

_Variable_

```ts
export const messageNotifications = [
  MessageReceivedNotificationDefinition,
] as const
```

Message notification catalog.

### [`messagePartsSchema`](./index.ts#L135)

_Function_

```ts
export function messagePartsSchema(): typeof MessagePartsSchema
```

Return the canonical message-parts schema.

**Returns:** The canonical message-parts schema.

### [`MessageReceivedNotification`](./index.ts#L260)

_TypeAlias_

```ts
export type MessageReceivedNotification = Schema.Schema.Type<
  typeof MessageReceivedNotificationSchema
>;
```

Notification payload for `messages/received`.

### [`MessageReceivedNotificationDefinition`](./index.ts#L268)

_Variable_

```ts
export const MessageReceivedNotificationDefinition = defineNotification({
  name: "messages/received",
  params: MessageReceivedNotificationSchema,
})
```

Pushed when a new message is delivered to your WebSocket connection.

### [`MessagesList`](./index.ts#L242)

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

### [`MessagesSend`](./index.ts#L192)

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

### [`MessageWithDispatchDecision`](./index.ts#L319)

_TypeAlias_

```ts
export type MessageWithDispatchDecision = Schema.Schema.Type<
  typeof MessageWithDispatchDecisionSchema
>;
```

Message row visible to app callers, including the dispatch decision.

### [`messageWithDispatchDecisionSchema`](./index.ts#L335)

_Function_

```ts
export function messageWithDispatchDecisionSchema(): typeof MessageWithDispatchDecisionSchema
```

Return the app-visible message schema that includes dispatch decisions.

**Returns:** The app-visible message schema.

### [`Part`](./index.ts#L87)

_TypeAlias_

```ts
export type Part = Schema.Schema.Type<typeof PartSchema>;
```

User-authored message content part.

### [`validateDispatchDecision`](./index.ts#L311)

_Variable_

```ts
export const validateDispatchDecision = closedGuard(DispatchDecisionSchema)
```

Return true when a value is a closed dispatch decision.

### [`validateMessage`](./index.ts#L129)

_Variable_

```ts
export const validateMessage = closedGuard(MessageSchema)
```

Return true when the value is a closed message row.

### [`validateTextPart`](./index.ts#L126)

_Variable_

```ts
export const validateTextPart = closedGuard(TextPartSchema)
```

Return true when the value is a closed text part.

## Files

- `index.ts`
