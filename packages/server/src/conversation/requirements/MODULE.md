# server-core/conversation/requirements

_`packages/server/src/conversation/requirements`_

## Purpose

Conversation-domain requirement helpers.

## Public surface

### [`authorizeConversationCreateCapacityOnly`](./create-authorization.ts#L15)

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

Capacity authorization for conversation creation. Validates that every
named target exists, then checks the resulting membership against the
group limit. The creator joins the conversation it opens, so it counts
toward the limit alongside the named targets.

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
