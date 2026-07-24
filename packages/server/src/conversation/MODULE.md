# server-core/conversation

_`packages/server/src/conversation`_

## Purpose

Conversation-domain service barrel.

## Public surface

### [`conversationCreate`](./handlers.ts#L315)

_Variable_

```ts
export const conversationCreate: ServerHandler<typeof ConversationCreate> = (
  params,
)
```

### [`conversationList`](./handlers.ts#L308)

_Variable_

```ts
export const conversationList: ServerHandler<typeof ConversationList> = (
  params,
)
```

### [`ConversationService`](./conversation.service.ts#L261)

_Class_

```ts
export class ConversationService {
  /** In-memory cache for last message previews — avoids decrypting on every list() call */
  private readonly previewCache = new BoundedMap<ConversationId, string>(
    PREVIEW_CACHE_MAX,
  );

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
    return Effect.gen(this, function* () {
      const task = yield* input.mintTask;
      const created = yield* this.insertConversation(input, task.id);
      yield* this.subscribeCreatedConversation(input, created.id);
      yield* this.logConversationCreated(input, created.id);
      return created;
    });
  }

  /** @internal */
  loadAgentOwners(
    agentIds: ReadonlyArray<AgentId>,
  ): Effect.Effect<
    ReadonlyMap<AgentId, UserId>,
    AgentNotFoundError | SqlError
  > {
    return Effect.gen(this, function* () {
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

  /** @internal */
  assertContactPolicyForCreate(
    creatorAgentId: AgentId,
    targetAgentIds: ReadonlyArray<AgentId>,
    ownerByAgentId: ReadonlyMap<AgentId, UserId>,
  ): Effect.Effect<void, AgentNotFoundError | NotInContactsError> {
    const policy = this.resolveContactPolicy();
    if (policy === null || targetAgentIds.length === 0) return Effect.void;
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
   * removal.
   * @internal
   */
  removeParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<void, NotAParticipantError, NetworkSendServiceTag> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        // Snapshot membership BEFORE delete so the evicted agent
        // is included in the fan-out target list.
        const participantsSnapshot =
          yield* this.getParticipantAgentIds(conversationId);
        const taskRowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .select("task_id")
            .where("id", "=", conversationId),
        );
        const taskId = Option.match(taskRowOpt, {
          onNone: () => null,
          onSome: (row) => row.task_id,
        });
        const deleted = yield* this.db
          .deleteFrom("conversation_participants")
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", agentId)
```

### [`ConversationServiceLive`](./layer.ts#L15)

_Variable_

```ts
export const ConversationServiceLive = Layer.effect(
  ConversationServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const connections = yield* ConnectionManagerTag;
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    return new ConversationService(db, connections, () => {
      const contacts = appEndpointRegistry.getContactService();
      if (!contacts) return null;
      return (a, b) => contacts.areInContact(a, b);
    });
  }).pipe(Effect.withSpan("ConversationServiceLive")),
)
```

### [`ConversationServiceTag`](./layer.ts#L11)

_Class_

```ts
export class ConversationServiceTag extends Context.Tag(
  "moltzap/ConversationService",
)<ConversationServiceTag, ConversationService>() {}
```

### [`conversationUpdate`](./handlers.ts#L322)

_Variable_

```ts
export const conversationUpdate: ServerHandler<typeof ConversationUpdate> = (
  params,
)
```

## Files

- `conversation.service.ts`
- `handlers.ts`
- `layer.ts`
