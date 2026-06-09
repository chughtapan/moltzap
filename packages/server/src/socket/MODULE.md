# server-core/socket

_`packages/server/src/socket`_

## Purpose

Server WebSocket/session runtime boundary.

## Public surface

### [`AgentConnection`](./connection.ts#L112)

_Interface_

```ts
class AgentConnection extends Data.TaggedClass("AgentConnection")<
  ConnectionBase & {
    readonly auth: AgentContext;

    /**
     * Server-side message-delivery-routing state: the set of conversation
     * ids this connection is subscribed to (the fan-out membership gate in
     * `network-send.ts → connectionCanReceive`). Hydrated on connect via the
     * Connect handler's `hydrateConnectionState`; maintained on subscribe
     * (`ConnectionManager.subscribeAgentsToConversation`) and on
     * `ConversationService.removeParticipant`. App-armed connections have no
     * conversation membership, so this field lives on the agent arm only.
     */
    readonly conversationIds: Set<ConversationId>;
  }
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

/**
 * Principal context arms stored on authenticated socket connections. Handlers
 * receive the arm selected by each method's `requires` head.
 */
export class AgentContext extends Data.TaggedClass("AgentContext")<{
  readonly agentId: AgentId;
  readonly agentStatus: AgentStatus;
  readonly ownerUserId: UserId;
}> {}
```

Closed agent lifecycle states. Mirrors
`core-schema.sql → CREATE TYPE agent_status AS ENUM (...)`. The closed
union makes the active-agent check exhaustive — adding a state forces every
consumer switch to handle it.

### [`AppConnection`](./connection.ts#L132)

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

### [`AppTags`](./layer-tags.ts#L102)

_TypeAlias_

```ts
export type AppTags = TaskTags | AppHostTag;
```

App-layer allowlist: `apps.handlers.ts` (registration + dispatch
authorize).

### [`Connection`](./connection.ts#L141)

_TypeAlias_

```ts
export type Connection =
  | UnauthenticatedConnection
  | AgentConnection
  | AppConnection;

/**
 * Outcome of `ConnectionManager.authenticate`'s atomic transition. The
 * success arms are split per minted arm so the Connect handler's
 * `Match.value(outcome).pipe(Match.when({ kind: "ok-agent" }, ...))` narrows
 * `authed` structurally — no `as AgentConnection` cast.
 */
export type TransitionOutcome =
  | { readonly kind: "not-connected" }
```

The three-arm connection state — the connections map's only entry shape.

### [`ConnectionManager`](./connection.ts#L188)

_Class_

```ts
export class ConnectionManager {
  /**
   * The three-arm connections map. Module-private; the only mutators are
   * `addUnauthenticated` / `authenticate` / `rollbackToUnauthenticated` /
   * `removeAndReturn` below.
   */
  private readonly connectionsRef: Ref.Ref<
    HashMap.HashMap<ConnectionId, Connection>
  > = Effect.runSync(Ref.make(HashMap.empty<ConnectionId, Connection>()));

  /**
   * Insert a fresh `UnauthenticatedConnection`. Called by the socket handler
   * at WebSocket open. The Connect handler promotes it to the agent/app arm.
   */
  addUnauthenticated(
    connId: ConnectionId,
    socket: WebSocketRef,
    originator: Originator,
  ): Effect.Effect<void> {
    return Ref.update(this.connectionsRef, (map) =>
      HashMap.set(
        map,
        connId,
        new UnauthenticatedConnection({ connId, socket, originator }),
      ),
    );
  }

  /** Non-mutating read. Callers discriminate on the returned arm's `_tag`. */
  peek(connId: ConnectionId): Effect.Effect<Option.Option<Connection>> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => HashMap.get(map, connId)),
    );
  }

  /**
   * Snapshot of every connection arm. Callers iterate + discriminate on `_tag`
   * (e.g. the shutdown loop reads `arm.socket.shutdown`).
   */
  allConnections(): Effect.Effect<readonly Connection[]> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => Array.from(HashMap.values(map))),
    );
  }

  /** Current connection count. */
  currentSize(): Effect.Effect<number> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => HashMap.size(map)),
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
    return Ref.modify(this.connectionsRef, (map) => {
      const current = HashMap.get(map, connId);
      if (Option.isNone(current)) {
        return [{ kind: "not-connected" } as const, map];
      }
      return Match.value(current.value).pipe(
        Match.tag(
          "AgentConnection",
          (existing): [TransitionOutcome, typeof map] => [
            { kind: "already-connected", existing },
            map,
          ],
        ),
        Match.tag(
          "AppConnection",
          (existing): [TransitionOutcome, typeof map] => [
            { kind: "already-connected", existing },
            map,
          ],
        ),
        Match.tag(
          "UnauthenticatedConnection",
          (unauth): [TransitionOutcome, typeof map] => {
            const { outcome, minted } = mintAuthedArm(
              {
                connId: unauth.connId,
                socket: unauth.socket,
                originator: unauth.originator,
              },
              auth,
            );
            return [outcome, HashMap.set(map, connId, minted)];
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
    return Ref.update(this.connectionsRef, (map) => {
      const current = HashMap.get(map, connId);
      if (Option.isNone(current)) return map;
      // Auth fields are dropped; the shared socket/originator fields remain.
      const demote = (authed: AgentConnection | AppConnection) =>
        HashMap.set(
          map,
          connId,
          new UnauthenticatedConnection({
            connId: authed.connId,
            socket: authed.socket,
            originator: authed.originator,
          }),
        );
```

### [`makeCoreSocketHandler`](./server-socket.ts#L17)

_Function_

```ts
export function makeCoreSocketHandler(options: {
  readonly services: ResolvedServices;
  readonly disconnectionHooks: readonly DisconnectionHook[];
})
```

### [`makeRequirementMiddlewareLayers`](./auth-middleware-layers.ts#L349)

_Function_

```ts
export const makeRequirementMiddlewareLayers = (connId: ConnectionId)
```

Every per-socket requirement impl Layer, merged. The engine stacks each
requirement on the methods that declare it. `ConversationInTask` reads no
caller (pure params — it gates app-principal methods too); the rest peek the
caller's agent id.

### [`narrowByPolicy`](./principal-gate.ts#L99)

_Function_

```ts
export const narrowByPolicy = (
  principal: PrincipalRequirement | undefined,
  requireClaimed: boolean,
  connection: Connection,
): Effect.Effect<Principal, ForbiddenError>
```

Narrow the live arm to the principal a gated method's `requires` head demands.
A gated method always has a principal head: the empty-`requires` Connect path
carries no policy and never reaches this gate, so an `undefined` head here is a
wiring defect, not a caller-actionable error.

### [`Originator`](./connection.ts#L76)

_TypeAlias_

```ts
export type Originator = ReverseClient;

/**
 * The per-connection socket handle registered with `ConnectionManager`.
 */
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

The per-connection reverse `RpcClient&lt;ReverseRpcGroup>` the server fires
callbacks/notifications through. Constructed by protocol `MoltZapServer`
during socket accept and passed to
`ConnectionManager.addUnauthenticated` as a primitive-equivalent parameter.

### [`peekLiveArm`](./principal-gate.ts#L44)

_Function_

```ts
export const peekLiveArm = (
  manager: ConnectionManager,
  connId: ConnectionId,
): Effect.Effect<Connection>
```

Peek the live arm by `connId` off the shared manager. A missing entry is an
impossible-state defect: the socket-open path inserts the unauthenticated arm
before any resolver Layer is built in the same scope, and the close finalizer
removes it only as that scope tears down.

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
cannot be fired on the reverse channel by mistake. The caller
(`AppHost.callAppRpc`) sources the Originator from the registered
app's `AppEndpoint`, minted from the live `AppConnection` arm. Caller controls
timeout via `Effect.timeout` at the call site.

### [`TransitionOutcome`](./connection.ts#L152)

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

- `auth-middleware-layers.ts`
- `connection.ts`
- `context.ts`
- `layer-tags.ts`
- `principal-gate.ts`
- `server-socket.ts`
