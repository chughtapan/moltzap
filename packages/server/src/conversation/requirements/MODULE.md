# server-core/conversation/requirements

_`packages/server/src/conversation/requirements`_

## Purpose

Conversation-domain requirement helpers.

## Public surface

### [`authorizeConversationCreateCapacityOnly`](./create-authorization.ts#L17)

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

Capacity authorization for conversation creation. The capacity check runs
BEFORE the existence lookup so an oversized participants list is rejected
without reaching the database — the lookup's `IN` clause is bounded by the
group limit, not by whatever the caller sent on the wire. The creator
joins the conversation it opens, so it counts toward the limit alongside
the named targets; duplicates collapse before either check.

**Returns:** The authorize conversation create capacity only result.

### [`obtainConversationSendAccess`](./send-access.ts#L22)

_Function_

```ts
export const obtainConversationSendAccess = (input: {
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
}): Effect.Effect<
  ConversationSendAccessValue,
  ForbiddenError,
  ConversationServiceTag | MessageServiceTag
>
```

`ConversationSendAccess` obtain: prove the caller participates in the
conversation, then prove the conversation row still exists. A
`conversationId` that survives the participant check but vanishes from the
read is a true race (deletion) — surfaced as a defect, not a user error.

**Returns:** The obtain conversation send access result.

## Files

- `create-authorization.ts`
- `send-access.ts`
