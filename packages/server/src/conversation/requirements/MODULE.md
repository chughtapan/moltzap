# server-core/conversation/requirements

_`packages/server/src/conversation/requirements`_

## Purpose

Conversation-domain requirement helpers.

## Public surface

### [`authorizeConversationCreateCapacityOnly`](./create-authorization.ts#L17)

_Function_

```ts
export const authorizeConversationCreateCapacityOnly = (
  agentIds: ReadonlyArray<AgentId>,
): Effect.Effect<
  void,
  AgentNotFoundError | ConversationFullError,
  ConversationServiceTag
>
```

Capacity-only authorization for the app-originated
`app/conversation/create`. An app minting a conversation on the task's
behalf has no agent contact-edges of its own; the targets
are already gated by `requireAgentsAreInTaskParticipants` in the
handler, so the creator contact-policy basis does NOT apply. Only the
group-capacity check runs. Loading owners still validates every target
exists.

### [`guardConversationNotArchived`](./send-access.ts#L94)

_Function_

```ts
export const guardConversationNotArchived = (
  row: ConversationSendAccessValue,
): Effect.Effect<void, ConversationArchivedError>
```

Refine the conversation is open (`archived_at IS NULL`).

### [`guardReplyTarget`](./send-access.ts#L106)

_Function_

```ts
export const guardReplyTarget = (input: {
  readonly conversationId: ConversationId;
  readonly replyToId?: MessageId;
}): Effect.Effect<void, MessageNotFoundError, MessageServiceTag>
```

Refine the reply target: when the send names a `replyToId`, verify the
referenced message exists in the conversation (fails `MessageNotFound` if
absent); a send with no reply target passes with no DB read.

### [`guardTaskActive`](./send-access.ts#L77)

_Function_

```ts
export const guardTaskActive = (
  row: ConversationSendAccessValue,
): Effect.Effect<void, TaskClosedError>
```

Refine the task is active (status is NOT `closed`/`failed`). Called BEFORE
guardConversationNotArchived so a closed task surfaces `TaskClosed`
before the auto-archive's `ConversationArchived`.

### [`obtainConversationInTask`](./in-task.ts#L15)

_Function_

```ts
export const obtainConversationInTask = (
  input: TaskAndConversation,
): Effect.Effect<
  ConversationInTaskValue,
  ConversationNotFoundError,
  TaskServiceTag
>
```

### [`obtainConversationSendAccess`](./send-access.ts#L22)

_Function_

```ts
export const obtainConversationSendAccess = (input: {
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
  readonly taskId?: TaskId;
}): Effect.Effect<
  ConversationSendAccessValue,
  ForbiddenError,
  ConversationServiceTag | MessageServiceTag
>
```

`ConversationSendAccess` obtain: prove the caller participates in the
conversation, then do the ONE joined read (`conversations ⋈ tasks`). The row
it returns is the shared context the send handler guards read from, so the
whole send path costs one joined read. A `conversationId` that
survives the participant check but vanishes from the join is a true race
(archival/deletion) — surfaced as a defect, not a user error.

### [`TaskAndConversation`](./in-task.ts#L10)

_Interface_

```ts
export interface TaskAndConversation {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}
```

## Files

- `create-authorization.ts`
- `in-task.ts`
- `send-access.ts`
