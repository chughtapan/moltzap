# server-core/socket

_`packages/server/src/socket`_

## Purpose

Server WebSocket connection/session runtime primitives.

## Public surface

### [`AgentConnection`](./connection.ts#L112)

_Interface_

```ts
class AgentConnection extends Data.TaggedClass("AgentConnection")<
  ConnectionBase & { readonly auth: AgentContext }
> {
  private readonly __brand!: never;
}
```

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

### [`agentContextFrom`](./context.ts#L31)

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

### [`AgentStatus`](./context.ts#L10)

_TypeAlias_

```ts
export type AgentStatus = "active" | "suspended";
```

Closed agent lifecycle states. Mirrors
`core-schema.sql → CREATE TYPE agent_status AS ENUM (...)`. The closed
union makes the active-agent check exhaustive — adding a state forces every
consumer switch to handle it.

### [`AppConnection`](./connection.ts#L119)

_Interface_

```ts
class AppConnection extends Data.TaggedClass("AppConnection")<
  ConnectionBase & { readonly auth: AppContext }
> {
  private readonly __brand!: never;
}
```

### [`AppContext`](./context.ts#L22)

_Class_

```ts
export class AppContext extends Data.TaggedClass("AppContext")<{
  readonly appId: AppId;
}> {}
```

### [`Connection`](./connection.ts#L128)

_TypeAlias_

```ts
export type Connection =
  | UnauthenticatedConnection
  | AgentConnection
  | AppConnection;
```

The three-arm connection state — the connections map's only entry shape.

### [`ConnectionManager`](./connection.ts#L217)

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

  /** Non-mutating read. Callers discriminate on the returned arm's `_tag`. */
  peek(connId: ConnectionId): Effect.Effect<Option.Option<Connection>> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => HashMap.get(state.connections, connId)),
    );
  }

  /**
   * Snapshot of every connection arm. Callers iterate + discriminate on `_tag`
   * (e.g. the shutdown loop reads `arm.socket.shutdown`).
   */
  allConnections(): Effect.Effect<readonly Connection[]> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => Array.from(HashMap.values(state.connections))),
    );
  }

  /** Current connection count. */
  currentSize(): Effect.Effect<number> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => HashMap.size(state.connections)),
    );
  }

  /**
   * Atomic per-connection authentication gate. Pattern-matches on
   * `auth._tag` once to decide which arm to mint. Returns a split-per-arm
   * `TransitionOutcome` so callers narrow without a cast.
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
              },
            ];
          },
        ),
        Match.exhaustive,
      );
    });
  }

  /**
   * Roll an authenticated arm back to `UnauthenticatedConnection` on a
   * post-auth failure. Idempotent: no-op when the entry is absent or already
   * unauthenticated — safe against a racing close handler.
   */
  rollbackToUnauthenticated(connId: ConnectionId): Effect.Effect<void> {
```

### [`ConnectionManagerLive`](./layer.ts#L16)

_Variable_

```ts
export const ConnectionManagerLive = Layer.sync(
  ConnectionManagerTag,
  () => new ConnectionManager(),
)
```

### [`ConnectionManagerTag`](./layer.ts#L12)

_Class_

```ts
export class ConnectionManagerTag extends Context.Tag(
  "moltzap/ConnectionManager",
)<ConnectionManagerTag, ConnectionManager>() {}
```

### [`ConnectionTag`](./layer.ts#L7)

_Class_

```ts
export class ConnectionTag extends Context.Tag("moltzap/Connection")<
  ConnectionTag,
  Connection
>() {}
```

### [`Originator`](./connection.ts#L76)

_TypeAlias_

```ts
export type Originator = ReverseClient;
```

The per-connection reverse `RpcClient&lt;ReverseRpcGroup>` the server fires
callbacks/notifications through. Constructed by protocol `MoltZapServer`
during socket accept and passed to
`ConnectionManager.addUnauthenticated` as a primitive-equivalent parameter.

### [`sendRpcToClient`](./connection.ts#L26)

_Function_

```ts
export function sendRpcToClient(
  originator: Originator,
  request: Extract<
    ReverseCallbackRequest,
    { readonly definition: typeof DispatchAuthorize }
  >,
): Effect.Effect<
  ReverseCallbackSuccess<typeof DispatchAuthorize>,
  ReverseCallbackError<typeof DispatchAuthorize> | ReverseCallError,
  never
>
```

Send an awaitable RPC from server → client over the connection's reverse
client. Narrows `D` to the moderator-callback union so a client→server method
cannot be fired on the reverse channel by mistake. Domain callback services
source the Originator from the registered app's `AppEndpoint`, minted
from the live `AppConnection` arm. Caller controls timeout via
`Effect.timeout` at the call site.

### [`TransitionOutcome`](./connection.ts#L139)

_TypeAlias_

```ts
export type TransitionOutcome =
  | { readonly kind: "not-connected" }
```

Outcome of `ConnectionManager.authenticate`'s atomic transition. The
success arms are split per minted arm so the Connect handler's
`Match.value(outcome).pipe(Match.when({ kind: "ok-agent" }, ...))` narrows
`authed` structurally — no `as AgentConnection` cast.

### [`UnauthenticatedConnection`](./connection.ts#L105)

_Interface_

```ts
class UnauthenticatedConnection extends Data.TaggedClass(
  "UnauthenticatedConnection",
)<ConnectionBase> {
  private readonly __brand!: never;
}
```

### [`WebSocketRef`](./connection.ts#L81)

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
