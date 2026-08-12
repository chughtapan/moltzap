# server-core/socket

_`packages/server/src/socket`_

## Purpose

Server WebSocket connection/session runtime primitives.

## Public surface

### [`AgentConnection`](./connection.ts#L89)

_Interface_

```ts
class AgentConnection extends Data.TaggedClass("AgentConnection")<
  ConnectionBase & { readonly auth: AgentContext }
> {
  private readonly brandValue!: never;
}
```

Re-exports the public API from `current module`.

### [`AgentContext`](./connection.ts#L29)

_Class_

```ts
export class AgentContext extends Data.TaggedClass("AgentContext")<{
  readonly agentId: AgentId;
  readonly agentStatus: AgentStatus;
  readonly ownerUserId: UserId;
}> {}
```

The principal context stored on an authenticated socket connection. Every
gated method's `requires` head selects this arm.

### [`agentContextFrom`](./connection.ts#L45)

_Function_

```ts
export function agentContextFrom(parts: {
  readonly agentId: AgentId;
  readonly agentStatus: string;
  readonly ownerUserId: UserId;
}): Effect.Effect<AgentContext>
```

Mint an AgentContext from authenticator fields. The `agent_status`
SQL enum constrains stored values to AgentStatus, but the DB driver
types it as `string`, so any other value is an impossible-state defect.

**Returns:** The agent context from result.

### [`AgentStatus`](./connection.ts#L23)

_TypeAlias_

```ts
export type AgentStatus = "active" | "suspended";
```

Closed agent lifecycle states. Mirrors
`core-schema.sql → CREATE TYPE agent_status AS ENUM (...)`. The closed
union makes the active-agent check exhaustive — adding a state forces every
consumer switch to handle it.

### [`Connection`](./connection.ts#L99)

_TypeAlias_

```ts
export type Connection = UnauthenticatedConnection | AgentConnection;
```

The two-arm connection state — the connections map's only entry shape.

### [`ConnectionManager`](./connection.ts#L176)

_Class_

```ts
export class ConnectionManager {
  /**
   * Connections and their per-agent delivery projection share one Ref so
   * authentication, disconnect cleanup, and subscription updates are atomic.
   * This prevents an old last-disconnect cleanup from deleting a newly
   * authenticated socket's freshly hydrated subscriptions.
   */
  private readonly stateRef: Ref.Ref<ConnectionManagerState> = Effect.runSync(
    Ref.make({
      connections: HashMap.empty<ConnectionId, Connection>(),
      agentConversationSubscriptions: HashMap.empty<
        AgentId,
        HashSet.HashSet<ConversationId>
      >(),
    }),
  );

  /**
   * Insert a fresh `UnauthenticatedConnection`. Called by the socket handler
   * at WebSocket open. The Connect handler promotes it to the agent arm.
   * @param connId Value supplied to the operation.
   * @param originator Value supplied to the operation.
   * @returns The add unauthenticated result.
   */
  addUnauthenticated(
    connId: ConnectionId,
    originator: ReverseClient,
  ): Effect.Effect<void> {
    return Ref.update(this.stateRef, (state) => ({
      ...state,
      connections: HashMap.set(
        state.connections,
        connId,
        new UnauthenticatedConnection({ connId, originator }),
      ),
    }));
  }

  /**
   * Non-mutating read. Callers discriminate on the returned arm's `_tag`.
   * @param connId Value supplied to the operation.
   * @returns The current result.
   */
  peek(connId: ConnectionId): Effect.Effect<Option.Option<Connection>> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => HashMap.get(state.connections, connId)),
    );
  }

  /**
   * Current connection count.
   * @returns The current result.
   */
  currentSize(): Effect.Effect<number> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => HashMap.size(state.connections)),
    );
  }

  /**
   * Atomic per-connection authentication gate. Mints the agent arm from the
   * unauthenticated entry and returns a `TransitionOutcome` whose success arm
   * carries the minted connection, so callers narrow without a cast.
   * @param connId Value supplied to the operation.
   * @param auth Value supplied to the operation.
   * @returns The current result.
   */
  authenticate(
    connId: ConnectionId,
    auth: AgentContext,
  ): Effect.Effect<TransitionOutcome> {
    return Ref.modify(this.stateRef, (state) => {
      const current = HashMap.get(state.connections, connId);
      if (Option.isNone(current)) {
        return [{ kind: "not-connected" } as const, state];
      }
      return Match.value(current.value).pipe(
        Match.tag(
          "AgentConnection",
          (existing): [TransitionOutcome, typeof state] => [
            { kind: "already-connected", existing },
            state,
          ],
        ),
        Match.tag(
          "UnauthenticatedConnection",
          (unauth): [TransitionOutcome, typeof state] => {
            const authed = new AgentConnection({
              connId: unauth.connId,
              originator: unauth.originator,
              auth,
            });
            return [
              { kind: "ok-agent", authed },
              {
                ...state,
                connections: HashMap.set(state.connections, connId, authed),
              },
            ];
          },
        ),
        Match.exhaustive,
      );
    });
  }

  /**
   * Atomic delete + return. Returns the removed
   * arm (or `undefined`) so the caller `Match.tag`s for auth-gated cleanup.
   * @param connId Value supplied to the operation.
   * @returns The current result.
   */
  removeAndReturn(connId: ConnectionId): Effect.Effect<Connection | undefined> {
    return Ref.modify(
      this.stateRef,
      (state): [Connection | undefined, ConnectionManagerState] => {
        const current = HashMap.get(state.connections, connId);
        if (Option.isNone(current)) {
          return [undefined, state];
        }
```

Implements connection manager.

### [`connectionManagerLive`](./connection.ts#L405)

_Variable_

```ts
export const connectionManagerLive = Layer.sync(
  ConnectionManagerTag,
  () => new ConnectionManager(),
)
```

Provides the connection manager live runtime value.

### [`ConnectionManagerTag`](./connection.ts#L400)

_Class_

```ts
export class ConnectionManagerTag extends Context.Tag(
  "moltzap/ConnectionManager",
)<ConnectionManagerTag, ConnectionManager>() {}
```

Implements connection manager tag.

### [`ConnectionTag`](./connection.ts#L394)

_Class_

```ts
export class ConnectionTag extends Context.Tag("moltzap/Connection")<
  ConnectionTag,
  Connection
>() {}
```

Implements connection tag.

### [`PrincipalBoundaryCanaries`](./principal.types-check.ts#L73)

_TypeAlias_

```ts
export type PrincipalBoundaryCanaries = [
  UnauthenticatedHasNoAuth,
  ForgedAgentRejected,
];
```

Compile-time assertions for the principal boundaries.

### [`principalCanaryRefs`](./principal.types-check.ts#L81)

_Variable_

```ts
export const principalCanaryRefs: readonly unknown[] = [
  agentIdValue,
  principalTag,
  narrowOutcome,
] as const
```

Provides the principal canary refs runtime value.

### [`TransitionOutcome`](./connection.ts#L107)

_TypeAlias_

```ts
export type TransitionOutcome =
  | { readonly kind: "not-connected" }
```

Outcome of `ConnectionManager.authenticate`'s atomic transition. The success
arm carries the minted connection so the Connect handler's
`Match.value(outcome).pipe(Match.when({ kind: "ok-agent" }, ...))` narrows
`authed` structurally — no `as AgentConnection` cast.

### [`UnauthenticatedConnection`](./connection.ts#L83)

_Interface_

```ts
class UnauthenticatedConnection extends Data.TaggedClass(
  "UnauthenticatedConnection",
)<ConnectionBase> {
  private readonly brand!: never;
}
```

Re-exports the public API from `current module`.

## Files

- `connection.ts`
- `principal.types-check.ts`
