# server-core/conversation

_`packages/server/src/conversation`_

## Purpose

Conversation-domain service barrel.

## Public surface

### [`conversationCreate`](./handlers.ts#L208)

_Variable_

```ts
export const conversationCreate: ServerHandler<
  typeof conversationCreateDefinition
> = (params)
```

Provides the conversation create runtime value.

**Returns:** The conversation create result.

### [`conversationList`](./handlers.ts#L196)

_Variable_

```ts
export const conversationList: ServerHandler<
  typeof conversationListDefinition
> = (params)
```

Provides the conversation list runtime value.

**Returns:** The conversation list result.

### [`ConversationService`](./conversation.service.ts#L260)

_Class_

```ts
export class ConversationService {
  /** In-memory cache for last-message previews, avoiding repeated decryption. */
  private readonly previewCache = new BoundedMap<ConversationId, string>(
    PREVIEW_CACHE_MAX,
  );

  private readonly db: Db;
  private readonly connections: ConnectionManager;
  private readonly resolveContactPolicy: ContactPolicyResolver;

  constructor(
    db: Db,
    connections: ConnectionManager,
    resolveContactPolicy?: ContactPolicyResolver,
  ) {
    this.db = db;
    this.connections = connections;
    this.resolveContactPolicy =
      resolveContactPolicy ?? NO_CONTACT_POLICY_RESOLVER;
  }

  /**
   * Writes the plaintext preview before message-part encryption.
   * @param conversationId Value supplied to the operation.
   * @param firstPartText Value supplied to the operation.
   */
  updatePreviewCache(
    conversationId: ConversationId,
    firstPartText: string,
  ): void {
    this.previewCache.set(
      conversationId,
      firstPartText.slice(0, PREVIEW_CACHE_TEXT_CHARS),
    );
  }

  create<TaskMintError = never>(
    input: CreateConversationOptions<TaskMintError>,
  ): Effect.Effect<Conversation, TaskMintError> {
    return catchSqlErrorAsDefect(this.createConversationEffect(input));
  }

  private createConversationEffect<TaskMintError>(
    input: CreateConversationOptions<TaskMintError>,
  ): Effect.Effect<Conversation, TaskMintError | SqlError> {
    return Effect.gen(this, function* (this: ConversationService) {
      const task = yield* input.mintTask;
      const created = yield* this.insertConversation(input, task.id);
      yield* this.subscribeCreatedConversation(input, created.id);
      yield* this.logConversationCreated(input, created.id);
      return created;
    });
  }

  /**
   * Loads the owner of every requested agent.
   * @param agentIds Value supplied to the operation.
   * @internal
   * @returns The rows result.
   */
  loadAgentOwners(
    agentIds: readonly AgentId[],
  ): Effect.Effect<
    ReadonlyMap<AgentId, UserId>,
    AgentNotFoundError | SqlError
  > {
    return Effect.gen(this, function* (this: ConversationService) {
      const rows =
        agentIds.length === 0
          ? []
          : yield* this.db
              .selectFrom("agents")
              .select(["id", "owner_user_id"])
              .where("id", "in", [...agentIds]);
      const ownerByAgentId = new Map<AgentId, UserId>();
      for (const row of rows) {
        ownerByAgentId.set(row.id, row.owner_user_id);
      }
      for (const agentId of agentIds) {
        if (!ownerByAgentId.has(agentId)) {
          return yield* Effect.fail(
            new AgentNotFoundError({ message: `Agent ${agentId} not found` }),
          );
        }
      }
      return ownerByAgentId;
    });
  }

  /**
   * Enforces creator-to-target contact policy for a new conversation.
   * @param creatorAgentId Value supplied to the operation.
   * @param targetAgentIds Value supplied to the operation.
   * @param ownerByAgentId Value supplied to the operation.
   * @internal
   * @returns The policy result.
   */
  assertContactPolicyForCreate(
    creatorAgentId: AgentId,
    targetAgentIds: readonly AgentId[],
    ownerByAgentId: ReadonlyMap<AgentId, UserId>,
  ): Effect.Effect<void, AgentNotFoundError | NotInContactsError> {
    const policy = this.resolveContactPolicy();
    if (policy === null || targetAgentIds.length === 0) {
      return Effect.void;
    }
    return this.assertCreatorContactsAll({
      creatorAgentId,
      targetAgentIds,
      ownerByAgentId,
      policy,
    });
  }

  /**
   * Reduced-surface participant removal: NO authority gate. Used by
   * `AppEndpointRegistry.removeDeniedParticipant` for dispatch-deny eviction
   * (runs server-internally, not via a wire RPC). Broadcasts
   * `ConversationParticipantsRemoved` with `reason: "app_remove"`
   * so the evicted agent and the remaining participants observe the
```

Implements conversation service.

### [`conversationServiceLive`](./layer.ts#L17)

_Variable_

```ts
export const conversationServiceLive = Layer.effect(
  ConversationServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const connections = yield* ConnectionManagerTag;
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    return new ConversationService(db, connections, () => {
      const contacts = appEndpointRegistry.getContactService();
      if (!contacts) {
        return null;
      }
      return (a, b) => contacts.areInContact(a, b);
    });
  }).pipe(Effect.withSpan("ConversationServiceLive")),
)
```

Provides the conversation service live runtime value.

### [`ConversationServiceTag`](./layer.ts#L12)

_Class_

```ts
export class ConversationServiceTag extends Context.Tag(
  "moltzap/ConversationService",
)<ConversationServiceTag, ConversationService>() {}
```

Implements conversation service tag.

### [`conversationUpdate`](./handlers.ts#L220)

_Variable_

```ts
export const conversationUpdate: ServerHandler<
  typeof conversationUpdateDefinition
> = (params)
```

Provides the conversation update runtime value.

**Returns:** The conversation update result.

## Files

- `conversation.service.ts`
- `handlers.ts`
- `layer.ts`
