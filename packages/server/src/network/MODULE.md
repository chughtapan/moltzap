# server-core/network

_`packages/server/src/network`_

## Purpose

Network-domain utilities.

## Public surface

### [`AgentEndpointResolver`](./agent-endpoint-resolver.ts#L64)

_Class_

```ts
export class AgentEndpointResolver {
  static readonly make: Effect.Effect<AgentEndpointResolver> = Effect.map(
    Ref.make<ResolverState>(emptyState),
    (state) => new AgentEndpointResolver(state),
  );

  private constructor(private readonly state: Ref.Ref<ResolverState>) {}

  /**
   * Atomically associate `(agentId, connectionId)` and the reverse
   * `(connectionId → agentId)` entry.
   *
   * Idempotent on the forward set: re-adding the same connection to the
   * same agent leaves the set unchanged ({@link HashSet.add} is set-union
   * semantics).
   *
   * Cross-agent ownership conflict: if `connectionId` is already in the
   * reverse index for a *different* agent, the new add takes ownership —
   * the connection is removed from
   * the prior agent's forward set inside the same `Ref.update` so the
   * forward and reverse views stay invariant. Practically unreachable
   * but the detection is cheap and the alternative is a silent
   * forward-map leak.
   */
  add(agentId: AgentId, connId: ConnectionId): Effect.Effect<void> {
    return Ref.update(this.state, (s) => {
      const prior = HashMap.get(s.byConnection, connId);
      let byAgent = s.byAgent;
      if (Option.isSome(prior) && prior.value !== agentId) {
        byAgent = HashMap.modifyAt(byAgent, prior.value, (existing) =>
          Option.flatMap(existing, (set) => {
            const next = HashSet.remove(set, connId);
            return HashSet.size(next) === 0 ? Option.none() : Option.some(next);
          }),
        );
      }
      return {
        byAgent: HashMap.modifyAt(byAgent, agentId, (existing) =>
          Option.some(
            Option.match(existing, {
              onNone: () => HashSet.make(connId),
              onSome: (set) => HashSet.add(set, connId),
            }),
          ),
        ),
        byConnection: HashMap.set(s.byConnection, connId, agentId),
      };
    });
  }

  /**
   * Atomically drop `(agentId, connectionId)` from the forward multimap
   * and, if the pair was actually present in the agent's set, drop
   * `connectionId` from the reverse index too.
   *
   * Idempotent. Calling `remove` for a `(agentId, connectionId)` pair
   * that was never added is a no-op — the disconnect path can fire it
   * unconditionally when the connection authed. For never-authed
   * connections, the disconnect path simply skips the call (no agentId
   * to address it with) and the resolver state is unchanged.
   *
   * Tearing the invariant matters when `connectionId` is genuinely owned
   * by a *different* agent than the caller asserts. The reverse index
   * is only cleared when `byAgent[agentId]` actually held `connectionId`;
   * a stray `remove(WRONG_AGENT, conn)` therefore cannot evict
   * `byConnection[conn]` from under the rightful owner. This guarantees
   * the two maps stay consistent under any sequence of mis-targeted
   * removes (programmer error or a re-issued lifecycle hook).
   *
   * If removing `connectionId` empties the agent's set, the agent key
   * itself is dropped from the forward map so {@link resolveAll} returns
   * the empty set rather than hitting an empty bucket.
   */
  remove(agentId: AgentId, connId: ConnectionId): Effect.Effect<void> {
    return Ref.update(this.state, (s) => {
      const existed = Option.match(HashMap.get(s.byAgent, agentId), {
        onNone: () => false,
        onSome: (set) => HashSet.has(set, connId),
      });
      if (!existed) return s;
      return {
        byAgent: HashMap.modifyAt(s.byAgent, agentId, (existing) =>
          Option.flatMap(existing, (set) => {
            const next = HashSet.remove(set, connId);
            return HashSet.size(next) === 0 ? Option.none() : Option.some(next);
          }),
        ),
        byConnection: HashMap.remove(s.byConnection, connId),
      };
    });
  }

  /**
   * Hot-path fan-out lookup. Returns every connection id currently
   * associated with `agentId`. Read-only snapshot — the `HashSet` is
   * immutable and the caller cannot mutate the resolver through it.
   */
  resolveAll(agentId: AgentId): Effect.Effect<HashSet.HashSet<ConnectionId>> {
    return Effect.map(Ref.get(this.state), (s) =>
      Option.getOrElse(HashMap.get(s.byAgent, agentId), () =>
        HashSet.empty<ConnectionId>(),
      ),
    );
  }
}
```

Multimap of agent → connection ids, plus a reverse index from
connection → agent.

All mutators run inside a single Ref.update so the forward and
reverse views never disagree, even under concurrent add /
remove calls from independent `agent/network/connect` and disconnect
fibers.

### [`applyOutboundWebhookCap`](./outbound-webhook-cap.ts#L44)

_Function_

```ts
export function applyOutboundWebhookCap(
  client: HttpClientNs.HttpClient,
): HttpClientNs.HttpClient
```

Wrap an `HttpClient.HttpClient` with OUTBOUND_WEBHOOK_PERMITS.
Used by the standalone contact-policy wiring so the same 10-permit pool
covers outbound webhook traffic in the process.

### [`broadcastNotificationToAgents`](./notification-broadcast.ts#L19)

_Function_

```ts
export const broadcastNotificationToAgents = <
  D extends AnyNotificationDefinition,
>(
  agentIds: readonly AgentId[],
  definition: D,
  params: NotificationParamsOf<D>,
  options?: BroadcastOptions,
): Effect.Effect<void, never, NetworkSendServiceTag>
```

Fan a server→client notification out to every live connection of each agent
in `agentIds`. The notification rides the reverse `RpcClient` on each target
connection (fired fork-and-forget, the `void` result settles on the client's
ack); the client's reverse `RpcServer` routes it into its
`SubscriberRegistry`. Replaces the raw `socket.write(encodedFrame)` path.

### [`connectAgent`](./connect.handlers.ts#L446)

_Variable_

```ts
export const connectAgent: ServerHandler<typeof AgentConnect> = (params)
```

### [`connectApp`](./connect.handlers.ts#L449)

_Variable_

```ts
export const connectApp: ServerHandler<typeof AppConnect> = (params)
```

### [`connectionId`](./agent-endpoint-resolver.ts#L37)

_Variable_

```ts
export const connectionId: (value: string)
```

Decode a raw connection-id string through the protocol brand constructor.
Used by tests that name connections with synthetic strings; production
socket accept uses `newConnectionId` from protocol.

### [`DeliveryAck`](./network-send.ts#L41)

_Class_

```ts
export class DeliveryAck extends Data.TaggedClass("DeliveryAck")<{
  readonly to: AgentId;
}> {}
```

Successful single-recipient write. The fan-out variant
NetworkSendService.broadcast returns the delivered agent ids
in its success channel and absorbs `DeliveryError` cases.

### [`DeliveryError`](./network-send.ts#L63)

_TypeAlias_

```ts
export type DeliveryError = RecipientNotResolved | WriteFailed;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface BroadcastOptions {
  readonly forConversation?: ConversationId;
  readonly excludeConnectionId?: ConnectionId;
  readonly messageId?: MessageId;
}
```

### [`NetworkSendService`](./network-send.ts#L87)

_Class_

```ts
export class NetworkSendService {
  constructor(
    private readonly resolver: AgentEndpointResolver,
    private readonly connections: ConnectionManager,
  ) {}

  /**
   * Route `payload` to one live connection of `agentId`. Iterates the
   * resolver set so a stale entry does not poison the send when a
   * sibling connection is still live. {@link RecipientNotResolved}
   * folds "no resolver entry" and "every resolved connection has gone
   * away" — callers can't act on the distinction without poking
   * internal state.
   */
  send(
    to: AgentId,
    payload: OpaquePayload,
  ): Effect.Effect<DeliveryAck, DeliveryError, never> {
    return Effect.gen(this, function* () {
      const conns = yield* this.resolver.resolveAll(to);
      for (const candidate of HashSet.values(conns)) {
        const conn = yield* this.connections.peek(candidate);
        if (Option.isNone(conn)) continue;
        yield* conn.value.socket.write(payload).pipe(
          Effect.either,
          Effect.flatMap(
            Either.match({
              onLeft: (cause) => Effect.fail(new WriteFailed({ to, cause })),
              onRight: () => Effect.void,
            }),
          ),
        );
        return new DeliveryAck({ to });
      }
      return yield* Effect.fail(new RecipientNotResolved({ to }));
    });
  }

  /**
   * Fan out `payload` across every live connection of every agent in
   * `agentIds`. Per-CONNECTION (multi-tab agents receive one frame per
   * live connection); writes are forked so a hung recipient does not
   * extend the caller's RPC latency.
   *
   * Filter options:
   * - `forConversation` — apply the per-connection subscription gate
   *   (`conn.conversationIds.has(...)`); absent, every connection
   *   of every listed agent receives.
   * - `excludeConnectionId` — skip the named connection. The
   *   `agent/message/send` author uses this to avoid echoing the RPC reply
   *   back as a notification.
   *
   * `delivered` lists agents whose at-least-one connection was
   * scheduled to receive a write — drives trace-capture's
   * offline-recipient accounting.
   */
  broadcast(
    agentIds: readonly AgentId[],
    payload: OpaquePayload,
    opts: BroadcastOptions = {},
  ): Effect.Effect<{ readonly delivered: readonly AgentId[] }, never, never> {
    return Effect.gen(this, function* () {
      const delivered: AgentId[] = [];
      for (const target of agentIds) {
        const reached = yield* this.broadcastToAgent(target, payload, opts);
        if (reached) delivered.push(target);
      }
      return { delivered };
    });
  }

  private broadcastToAgent(
    target: AgentId,
    payload: OpaquePayload,
    options: BroadcastOptions,
  ): Effect.Effect<boolean, never, never> {
    return Effect.gen(this, function* () {
      const connIds = yield* this.resolver.resolveAll(target);
      let agentReached = false;
      for (const cid of HashSet.values(connIds)) {
        const connOpt = yield* this.connectionCanReceive(cid, options);
        if (Option.isNone(connOpt)) continue;
        yield* this.forkBroadcastWrite({
          cid,
          conn: connOpt.value,
          target,
          payload,
          options,
        });
        agentReached = true;
      }
      return agentReached;
    });
  }

  /**
   * Gate one resolved connection for conversation fan-out. Returns the
   * gate-passing {@link AgentConnection} (so the caller threads it into
   * {@link forkBroadcastWrite} without a second `peek`), or `None` when
   * the connection is excluded, gone, not an agent arm, or not a member
   * of the target conversation.
   */
  private connectionCanReceive(
    cid: ConnectionId,
    options: BroadcastOptions,
  ): Effect.Effect<Option.Option<AgentConnection>> {
    return Effect.gen(this, function* () {
      if (
        options.excludeConnectionId !== undefined &&
        cid === options.excludeConnectionId
      ) {
        return Option.none();
      }
      const connOpt = yield* this.connections.peek(cid);
      if (Option.isNone(connOpt)) return Option.none();
      const conn = connOpt.value;
      // Only authenticated agent arms participate in conversation fan-out;
      // unauthenticated and app arms have no `conversationIds` membership.
      if (conn._tag !== "AgentConnection") return Option.none();
      const conversationId = options.forConversation;
```

Outbound-routing primitive. Use the constructor directly in code;
route through `NetworkSendServiceTag` in DI-aware code.

### [`OpaquePayload`](./network-send.ts#L30)

_TypeAlias_

```ts
export type OpaquePayload = string & Brand.Brand<"OpaquePayload">;
```

Branded raw-string payload. The send primitive writes the exact
bytes to the recipient socket — no parse, no transform, no validate.
The nominal brand prevents an unwitting caller from passing an
arbitrary `string` where a wire-ready frame is expected.

## Files

- `agent-endpoint-resolver.ts`
- `connect.handlers.ts`
- `network-send.ts`
- `notification-broadcast.ts`
- `outbound-webhook-cap.ts`
