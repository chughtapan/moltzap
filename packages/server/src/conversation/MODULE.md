# server-core/conversation

_`packages/server/src/conversation`_

## Purpose

Conversation-domain service barrel.

## Public surface

### [`conversationCreate`](./handlers.ts#L298)

_Variable_

```ts
export const conversationCreate: ServerHandler<typeof ConversationCreate> = (
  params,
)
```

### [`conversationList`](./handlers.ts#L291)

_Variable_

```ts
export const conversationList: ServerHandler<typeof ConversationList> = (
  params,
)
```

### [`ConversationService`](./conversation.service.ts#L260)

_Class_

```ts
export class ConversationService {
  /** In-memory cache for last message previews — avoids decrypting on every list() call */
  private previewCache = new Map<ConversationId, string>();

  constructor(
    private db: Db,
    private connections: ConnectionManager,
    private resolveContactPolicy: ContactPolicyResolver = () => null,
  ) {}

  /** Writes the plaintext preview before message-part encryption. */
  updatePreviewCache(
    conversationId: ConversationId,
    firstPartText: string,
  ): void {
    this.previewCache.delete(conversationId);
    this.previewCache.set(
      conversationId,
      firstPartText.slice(0, PREVIEW_CACHE_TEXT_CHARS),
    );
    if (this.previewCache.size > PREVIEW_CACHE_MAX) {
      const oldest = this.previewCache.keys().next().value!;
      this.previewCache.delete(oldest);
    }
  }
```

### [`conversationUpdate`](./handlers.ts#L305)

_Variable_

```ts
export const conversationUpdate: ServerHandler<typeof ConversationUpdate> = (
  params,
)
```

## Files

- `conversation.service.ts`
- `handlers.ts`
