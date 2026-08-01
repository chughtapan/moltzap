# server-core/conversation

_`packages/server/src/conversation`_

## Purpose

Conversation-domain service barrel.

## Public surface

### [`agentConversationCreate`](./handlers.ts#L177)

_Variable_

```ts
export const agentConversationCreate: ServerHandler<
  typeof agentConversationCreateDefinition
> = Effect.fn("agentConversationCreate")(function* (params) {
  return yield* agentConversationCreateBody(params, yield* agentArm);
})
```

Provides the agent conversation create runtime value.

**Returns:** The agent conversation create result.

### [`conversationList`](./handlers.ts#L166)

_Variable_

```ts
export const conversationList: ServerHandler<
  typeof conversationListDefinition
> = Effect.fn("conversationList")(function* (params) {
  return yield* conversationListBody(params, yield* agentArm);
})
```

Provides the conversation list runtime value.

**Returns:** The conversation list result.

### [`ConversationService`](./conversation.service.ts#L223)

_Class_

```ts
export class ConversationService {
  private readonly db: Db;
  private readonly connections: ConnectionManager;

  constructor(db: Db, connections: ConnectionManager) {
    this.db = db;
    this.connections = connections;
  }

  create(input: CreateConversationOptions): Effect.Effect<Conversation> {
    return catchSqlErrorAsDefect(this.createConversationEffect(input));
  }

  private createConversationEffect(
    input: CreateConversationOptions,
  ): Effect.Effect<Conversation, SqlError> {
    return Effect.gen(
      function* (this: ConversationService) {
        const created = yield* this.insertConversation(input);
        yield* this.subscribeCreatedConversation(input, created.id);
        yield* this.logConversationCreated(input, created.id);
        return created;
      }.bind(this),
    );
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
    return Effect.gen(
      function* (this: ConversationService) {
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
            return yield* new AgentNotFoundError({
              message: `Agent ${agentId} not found`,
            });
          }
        }
        return ownerByAgentId;
      }.bind(this),
    );
  }

  /**
   * Reduced-surface participant removal: NO authority gate. Used by
   * `AppEndpointRegistry.removeDeniedParticipant` for dispatch-deny eviction
   * (runs server-internally, not via a wire RPC). Broadcasts
   * `ConversationParticipantsRemoved` with `reason: "app_remove"`
   * so the evicted agent and the remaining participants observe the
   * removal.
   * @param conversationId Value supplied to the operation.
   * @param agentId Identifier of the agent targeted by the operation.
   * @internal
   * @returns The participants snapshot result.
   */
  removeParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<void, NotAParticipantError, NetworkSendServiceTag> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: ConversationService) {
          // Snapshot membership BEFORE delete so the evicted agent
          // is included in the fan-out target list.
          const participantsSnapshot =
            yield* this.getParticipantAgentIds(conversationId);
          const deleted = yield* this.db
            .deleteFrom("conversation_participants")
            .where("conversation_id", "=", conversationId)
            .where("agent_id", "=", agentId)
            .returning("conversation_id");
          if (deleted.length === 0) {
            return yield* new NotAParticipantError({
              message: "Participant not found",
            });
          }
          yield* this.connections.removeConversationFromAgent(
            agentId,
            conversationId,
          );
          yield* broadcastNotificationToAgents(
            participantsSnapshot,
            conversationParticipantsRemovedNotificationDefinition,
            {
              conversationId,
              removedAgentId: agentId,
              reason: "app_remove" as const,
            },
          );
        }.bind(this),
      ),
    );
  }

  /**
   * Rejects a membership that exceeds the group limit. Callers pass the
   * resulting member count, so creation and participant addition share one
   * capacity rule.
   * @param memberCount Value supplied to the operation.
   * @internal
```

Implements conversation service.

### [`conversationServiceLive`](./layer.ts#L16)

_Variable_

```ts
export const conversationServiceLive = Layer.effect(
  ConversationServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const connections = yield* ConnectionManagerTag;
    return new ConversationService(db, connections);
  }).pipe(Effect.withSpan("ConversationServiceLive")),
)
```

Provides the conversation service live runtime value.

### [`ConversationServiceTag`](./layer.ts#L11)

_Class_

```ts
export class ConversationServiceTag extends Context.Tag(
  "moltzap/ConversationService",
)<ConversationServiceTag, ConversationService>() {}
```

Implements conversation service tag.

### [`conversationUpdate`](./handlers.ts#L188)

_Variable_

```ts
export const conversationUpdate: ServerHandler<
  typeof conversationUpdateDefinition
> = Effect.fn("conversationUpdate")(function* (params) {
  return yield* conversationUpdateBody(params, yield* appArm);
})
```

Provides the conversation update runtime value.

**Returns:** The conversation update result.

## Files

- `conversation.service.ts`
- `handlers.ts`
- `layer.ts`
