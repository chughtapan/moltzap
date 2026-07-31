# protocol/conversation/requirements

_`packages/protocol/src/conversation/requirements`_

## Purpose

Conversation-owned requirement middleware tags.

## Public surface

### [`ConversationSendAccess`](./conversation-send-access.ts#L18)

_Class_

```ts
export class ConversationSendAccess extends RpcMiddleware.Tag<ConversationSendAccess>()(
  "@moltzap/protocol/ConversationSendAccess",
  { failure: Schema.Union(ForbiddenError) },
) {}
```

Implements conversation send access.

### [`ConversationSendAccessValue`](./conversation-send-access.ts#L12)

_Interface_

```ts
export interface ConversationSendAccessValue {
  readonly conversationId: ConversationId;
  readonly appId: AppId;
}
```

Permission: the caller may send to this conversation, proven by participant
membership. The server obtain performs the joined read that feeds send
guards; `appId` is the conversation's authorizing app.

## Files

- `conversation-send-access.ts`
