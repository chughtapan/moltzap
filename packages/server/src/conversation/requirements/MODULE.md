# server-core/conversation/requirements

_`packages/server/src/conversation/requirements`_

## Purpose

Conversation-domain requirement helpers.

## Public surface

### [`assertCallerAppOwnsConversation`](./app-ownership.ts#L22)

_Function_

```ts
export const assertCallerAppOwnsConversation = (
  appId: AppId,
  conversationId: ConversationId,
): Effect.Effect<
  void,
  ForbiddenError | ConversationNotFoundError,
  ConversationServiceTag
>
```

App-principal ownership gate. App conversation-mutation handlers call this
before the service mutation; it compares the calling AppConnection's appId
against the conversation's routing key.

**Returns:** The assert caller app owns conversation result.

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

### [`guardTaskActive`](./send-access.ts#L79)

_Function_

```ts
export const guardTaskActive = (
  row: ConversationSendAccessValue,
): Effect.Effect<void, TaskClosedError>
```

Refine the task is active (status is NOT `closed`/`failed`).

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

### [`obtainConversationSendAccess`](./send-access.ts#L25)

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
join is a true race (deletion) — surfaced as a defect, not a user error.

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

- `app-ownership.ts`
- `create-authorization.ts`
- `in-task.ts`
- `send-access.ts`
