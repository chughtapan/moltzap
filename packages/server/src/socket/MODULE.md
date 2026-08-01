# server-core/socket

_`packages/server/src/socket`_

## Purpose

Server WebSocket connection/session runtime primitives.

## Public surface

### [`AgentConnection`](./connection.ts#L50)

_Interface_

```ts
class AgentConnection extends Data.TaggedClass("AgentConnection")<
  ConnectionBase & { readonly auth: AgentContext }
> {
  private readonly brandValue!: never;
}
```

Re-exports the public API from `current module`.

### [`AgentContext`](./context.ts#L16)

_Class_

```ts
export class AgentContext extends Data.TaggedClass("AgentContext")<{
  readonly agentId: AgentId;
  readonly agentStatus: AgentStatus;
  readonly ownerUserId: UserId;
}> {}
```

Principal context arms stored on authenticated socket connections. Handlers
receive the arm selected by each method's `requires` head.

### [`agentContextFrom`](./context.ts#L37)

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

### [`AgentStatus`](./context.ts#L10)

_TypeAlias_

```ts
export type AgentStatus = "active" | "suspended";
```

Closed agent lifecycle states. Mirrors
`core-schema.sql → CREATE TYPE agent_status AS ENUM (...)`. The closed
union makes the active-agent check exhaustive — adding a state forces every
consumer switch to handle it.

### [`AppConnection`](./connection.ts#L56)

_Interface_

```ts
class AppConnection extends Data.TaggedClass("AppConnection")<
  ConnectionBase & { readonly auth: AppContext }
> {
  private readonly brandValue!: never;
}
```

Re-exports the public API from `current module`.

### [`AppContext`](./context.ts#L23)

_Class_

```ts
export class AppContext extends Data.TaggedClass("AppContext")<{
  readonly appId: AppId;
}> {}
```

Implements app context.

### [`Connection`](./connection.ts#L66)

_TypeAlias_

```ts
export type Connection =
  | UnauthenticatedConnection
  | AgentConnection
  | AppConnection;
```

The three-arm connection state — the connections map's only entry shape.

### [`ConnectionManager`](./connection.ts#L170)

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
   * at WebSocket open. The Connect handler promotes it to the agent/app arm.
   * @param connId Value supplied to the operation.
   * @param socket Value supplied to the operation.
   * @param originator Value supplied to the operation.
   * @returns The add unauthenticated result.
   */
  addUnauthenticated(
    connId: ConnectionId,
    socket: WebSocketRef,
    originator: Originator,
  ): Effect.Effect<void> {
    return Ref.update(this.stateRef, (state) => ({
      ...state,
      connections: HashMap.set(
        state.connections,
        connId,
        new UnauthenticatedConnection({ connId, socket, originator }),
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
   * Snapshot of every connection arm. Callers iterate + discriminate on `_tag`
   * (e.g. The shutdown loop reads `arm.socket.shutdown`).
   * @returns The current result.
   */
  allConnections(): Effect.Effect<readonly Connection[]> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => Array.from(HashMap.values(state.connections))),
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
   * Atomic per-connection authentication gate. Pattern-matches on
   * `auth._tag` once to decide which arm to mint. Returns a split-per-arm
   * `TransitionOutcome` so callers narrow without a cast.
   * @param connId Value supplied to the operation.
   * @param auth Value supplied to the operation.
   * @returns The current result.
   */
  authenticate(
    connId: ConnectionId,
    auth: AgentContext | AppContext,
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
          "AppConnection",
          (existing): [TransitionOutcome, typeof state] => [
            { kind: "already-connected", existing },
            state,
          ],
        ),
        Match.tag(
          "UnauthenticatedConnection",
          (unauth): [TransitionOutcome, typeof state] => {
            const { outcome, minted } = mintAuthedArm(
              {
                connId: unauth.connId,
                socket: unauth.socket,
                originator: unauth.originator,
              },
              auth,
            );
            return [
              outcome,
              {
                ...state,
                connections: HashMap.set(state.connections, connId, minted),
```

Implements connection manager.

### [`connectionManagerLive`](./layer.ts#L19)

_Variable_

```ts
export const connectionManagerLive = Layer.sync(
  ConnectionManagerTag,
  () => new ConnectionManager(),
)
```

Provides the connection manager live runtime value.

### [`ConnectionManagerTag`](./layer.ts#L14)

_Class_

```ts
export class ConnectionManagerTag extends Context.Tag(
  "moltzap/ConnectionManager",
)<ConnectionManagerTag, ConnectionManager>() {}
```

Implements connection manager tag.

### [`ConnectionTag`](./layer.ts#L8)

_Class_

```ts
export class ConnectionTag extends Context.Tag("moltzap/Connection")<
  ConnectionTag,
  Connection
>() {}
```

Implements connection tag.

### [`Originator`](./connection.ts#L15)

_TypeAlias_

```ts
export type Originator = ReverseClient;
```

The per-connection reverse `RpcClient&lt;ReverseRpcGroup>` the server fires
callbacks/notifications through. Constructed by protocol `MoltZapServer`
during socket accept and passed to
`ConnectionManager.addUnauthenticated` as a primitive-equivalent parameter.

### [`PrincipalBoundaryCanaries`](./principal.types-check.ts#L101)

_TypeAlias_

```ts
export type PrincipalBoundaryCanaries = [
  AgentHasNoAppId,
  AppHasNoAgentId,
  UnauthenticatedHasNoAuth,
  ForgedAgentRejected,
  InvalidBootPhaseRejected,
];
```

Compile-time assertions for the principal and boot-failure boundaries.

### [`principalCanaryRefs`](./principal.types-check.ts#L112)

_Variable_

```ts
export const principalCanaryRefs: readonly unknown[] = [
  agentIdValue,
  appIdValue,
  principalTag,
  narrowOutcome,
  bootFail,
] as const
```

Provides the principal canary refs runtime value.

### [`TransitionOutcome`](./connection.ts#L77)

_TypeAlias_

```ts
export type TransitionOutcome =
  | { readonly kind: "not-connected" }
```

Outcome of `ConnectionManager.authenticate`'s atomic transition. The
success arms are split per minted arm so the Connect handler's
`Match.value(outcome).pipe(Match.when({ kind: "ok-agent" }, ...))` narrows
`authed` structurally — no `as AgentConnection` cast.

### [`UnauthenticatedConnection`](./connection.ts#L44)

_Interface_

```ts
class UnauthenticatedConnection extends Data.TaggedClass(
  "UnauthenticatedConnection",
)<ConnectionBase> {
  private readonly brand!: never;
}
```

Re-exports the public API from `current module`.

### [`WebSocketRef`](./connection.ts#L20)

_Interface_

```ts
export interface WebSocketRef {
  /**
   * Write a raw frame to this connection. Fails with SocketError on send
   * failure or if the socket is already closed.
   */
  readonly write: (raw: string) => Effect.Effect<void, SocketError>;
  /** Close this connection's scope, tearing down the underlying socket. */
  readonly shutdown: Effect.Effect<void>;
}
```

The per-connection socket handle registered with `ConnectionManager`.

## Files

- `connection.ts`
- `context.ts`
- `layer.ts`
- `principal.types-check.ts`
