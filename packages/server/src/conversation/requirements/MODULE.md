# server-core/conversation/requirements

_`packages/server/src/conversation/requirements`_

## Purpose

Conversation-domain requirement helpers.

## Public surface

### [`authorizeConversationCreateCapacityOnly`](./create-authorization.ts#L18)

_Function_

```ts
export const authorizeConversationCreateCapacityOnly = (
  agentIds: readonly AgentId[],
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

**Returns:** The authorize conversation create capacity only result.

### [`guardConversationNotArchived`](./send-access.ts#L105)

_Function_

```ts
export const guardConversationNotArchived = (
  row: ConversationSendAccessValue,
): Effect.Effect<void, ConversationArchivedError>
```

Refine the conversation is open (`archived_at IS NULL`).

**Returns:** The guard conversation not archived result.

### [`guardTaskActive`](./send-access.ts#L84)

_Function_

```ts
export const guardTaskActive = (
  row: ConversationSendAccessValue,
): Effect.Effect<void, TaskClosedError>
```

Refine the task is active (status is NOT `closed`/`failed`). Called BEFORE
guardConversationNotArchived so a closed task surfaces `TaskClosed`
before the auto-archive's `ConversationArchived`.

**Returns:** The guard task active result.

### [`obtainConversationInTask`](./in-task.ts#L21)

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

Provides the obtain conversation in task runtime value.

**Returns:** The obtain conversation in task result.

### [`obtainConversationSendAccess`](./send-access.ts#L27)

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
conversation, then do the joined read (`conversations ⋈ tasks`). The row it
returns is the shared context the send handler guards read from. A
`conversationId` that survives the participant check but vanishes from the
join is a true race (archival/deletion) — surfaced as a defect, not a user
error.

**Returns:** The obtain conversation send access result.

### [`TaskAndConversation`](./in-task.ts#L11)

_Interface_

```ts
export interface TaskAndConversation {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}
```

Describes task and conversation.

## Files

- `create-authorization.ts`
- `in-task.ts`
- `send-access.ts`
