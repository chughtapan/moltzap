# server-core/identity/agents

_`packages/server/src/identity/agents`_

## Purpose

Agent identity server internals.

## Public surface

### [`agentsList`](./handlers.ts#L133)

_Variable_

```ts
export const agentsList: ServerHandler<typeof AgentsList> = (params)
```

### [`AuthService`](./auth.service.ts#L16)

_Class_

```ts
export class AuthService {
  constructor(private db: Db) {}

  registerAgent(
    params: RegisterParams,

    /**
     * Populates `owner_user_id` at insert time. Callers MUST validate the value
     * upstream — this argument is treated as trusted.
     */
    ownerUserId: UserId,
  ): Effect.Effect<{ agentId: AgentId; apiKey: AgentKey }, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const { apiKey, keyId, secretHash } = generateApiKey();

        const result = yield* takeFirstOrFail(
          this.db
            .insertInto("agents")
            .values({
              name: params.name,
              description: params.description ?? null,
              api_key_id: keyId,
              api_key_secret_hash: secretHash,
              status: "active",
              owner_user_id: ownerUserId,
            })
            .returning(["id"]),
          "Failed to insert agent",
        );

        const agentId = result.id;

        yield* Effect.logInfo("Agent registered").pipe(
          Effect.annotateLogs({ agentId, name: params.name }),
        );

        return { agentId, apiKey };
      }),
    );
  }

  agentsForOwner(
    ownerUserId: UserId,
  ): Effect.Effect<ReadonlyArray<AgentId>, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .selectFrom("agents")
          .select(["id"])
          .where("owner_user_id", "=", ownerUserId)
          .where("status", "=", "active");
        return rows.map((r) => r.id);
      }),
    );
  }

  authenticateAgent(apiKey: AgentKey): Effect.Effect<
    {
      agentId: AgentId;
      status: string;
      ownerUserId: UserId;
    } | null,
    never
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const parsed = parseApiKey(apiKey);
        if (!parsed) return null;

        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select(["id", "api_key_secret_hash", "status", "owner_user_id"])
            .where("api_key_id", "=", parsed.keyId)
            .where("status", "!=", "suspended"),
        );

        if (Option.isNone(rowOpt)) return null;
        const row = rowOpt.value;
        if (hashSecret(parsed.secret) !== row.api_key_secret_hash) return null;

        return {
          agentId: row.id,
          status: row.status,
          ownerUserId: row.owner_user_id,
        };
      }),
    );
  }
}
```

### [`AuthServiceLive`](./layer.ts#L14)

_Variable_

```ts
export const AuthServiceLive = Layer.effect(
  AuthServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new AuthService(db);
  }).pipe(Effect.withSpan("AuthServiceLive")),
)
```

### [`AuthServiceTag`](./layer.ts#L9)

_Class_

```ts
export class AuthServiceTag extends Context.Tag("moltzap/AuthService")<
  AuthServiceTag,
  AuthService
>() {}
```

### [`visibleAgentIds`](./visibility.service.ts#L22)

_Function_

```ts
export function visibleAgentIds(
  req: VisibleAgentIdsRequest,
): Effect.Effect<ReadonlyArray<AgentId>, never>
```

### [`VisibleAgentIdsRequest`](./visibility.service.ts#L14)

_Interface_

```ts
export interface VisibleAgentIdsRequest {
  readonly db: Db;
  readonly callerAgentId: AgentId;
  readonly callerOwnerUserId: UserId;
  /** When set, intersect the visible set with these IDs. */
  readonly restrictTo?: ReadonlyArray<AgentId>;
}
```

## Files

- `auth.service.ts`
- `handlers.ts`
- `layer.ts`
- `visibility.service.ts`
