# server-core/network

_`packages/server/src/network`_

## Purpose

Network layer public barrel.

The network layer owns connect, presence, app task-manager registry,
agent-endpoint resolution, and outbound send or broadcast routing. It may
import kernels, transport, and identity, but not task or app.

## Public surface

### [`_ConnectionIdLeakCanaryAssertion`](./agent-endpoint-resolver.types-check.ts#L42)

_TypeAlias_

### [`AgentEndpointResolver`](./agent-endpoint-resolver.ts#L89)

_Class_

```ts
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
```

Multimap of agent → connection ids, plus a reverse index from
connection → agent.

All mutators run inside a single Ref.update so the forward and
reverse views never disagree, even under concurrent add /
remove calls from independent `network/connect` and disconnect
fibers.

### [`AppTmHandler`](./app-tm-registry.ts#L76)

_TypeAlias_

In-process app-TM handler. Receives the opaque wire frame
`network.send` would have written to a remote TM and runs on the
server's Effect runtime. Phase 9b's default handlers are no-op
observers (the existing `MessageService.send` insert+broadcast flow
runs regardless); future Phase 11+ arena cutover may wire richer
TM-driven storage authority.

The error channel is `never`: the handler must absorb its own
failures (log + drop) rather than propagating them to the
`messages/send` caller. `network.send`'s caller-facing error tags
cover delivery liveness only; application-level handler errors are
the TM's own concern.

### [`AppTmRegistry`](./app-tm-registry.ts#L86)

_Class_

Map-backed registry. `Ref` rather than a plain `Map` so the resolver
stays consistent under concurrent boot-time `register` calls (none
today, but the contract holds for future). Lookups are read-only
snapshots.

### [`connectionId`](./agent-endpoint-resolver.ts#L63)

_Function_

```ts
 * fibers.
 */
export class AgentEndpointResolver
```

Brand a raw connection-id string. Used by the resolver and its callers
(`auth.handlers.ts`, `app/server.ts`) so the maps stay strongly typed.

### [`ConnectionId`](./agent-endpoint-resolver.ts#L57)

_TypeAlias_

```ts
 * Multimap of agent → connection ids, plus a reverse index from
 * connection → agent.
 *
 * All mutators run inside a single {@link Ref.update} so the forward and
```

Branded type alias for a WebSocket connection id. Resolver internals
are pure `ConnectionId → AgentId` lookups; the brand exists so the
negative type-test canary at `agent-endpoint-resolver.types-check.ts`
can assert that `ConnectionId` is NOT assignable to `EndpointAddress`
— closing the surface that pre-Phase-9b leaked the per-connection
address through the resolver's public API.

The brand is nominal (string-shaped, no UUID predicate) because the
caller is `app/server.ts` minting the id via `crypto.randomUUID()`;
runtime validation would be redundant. Type-only friction prevents an
accidental confusion with `EndpointAddress`.

### [`DEFAULT_DM_TM_ADDRESS`](./app-tm-registry.ts#L30)

_Variable_

Stable `EndpointAddress` for the default DM TM. Used by
`conversations/create` when the caller does not own a TM and the
conversation type is `dm`. Phase 9b consumer-migration (sub-issue
#460 round 3 R12 + R14): every conversation now belongs to a task
with a registered TM; non-app DMs route through this stable address.

### [`DEFAULT_GROUP_TM_ADDRESS`](./app-tm-registry.ts#L38)

_Variable_

Stable `EndpointAddress` for the default group TM. Same role as
DEFAULT_DM_TM_ADDRESS for `type: "group"` conversations.

### [`defaultTmAddressForType`](./app-tm-registry.ts#L49)

_Function_

Pick the default TM endpoint for a conversation type. The DM/group
split is preserved as separate addresses (rather than one shared
default) so future differentiation (display semantics, rate limits)
can land without rewiring `tasks.tm_endpoint_address` for existing
rows.

### [`DeliveryAck`](./network-send.ts#L64)

_Class_

```ts
 */
export class WriteFailed extends Data.TaggedError("WriteFailed")<{
  readonly to: AgentId;
  readonly cause: Socket.SocketError;
}> {}
```

Successful single-recipient write. The fan-out variant
NetworkSendService.broadcast returns the delivered agent ids
in its success channel and absorbs `DeliveryError` cases.

### [`DeliveryError`](./network-send.ts#L88)

_TypeAlias_

```ts

/**
 * Outbound-routing primitive. Use the constructor directly in code;
```

### [`NetworkSendService`](./network-send.ts#L111)

_Class_

```ts
    return Effect.gen(this, function* () {
      const conns = yield* this.resolver.resolveAll(to);
      for (const candidate of HashSet.values(conns)) {
        const conn = this.connections.get(candidate);
        if (conn === undefined) continue;
        yield* conn.write(payload).pipe(
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
```

The outbound-routing primitive. Use the constructor directly in code;
route through `NetworkSendServiceTag` in DI-aware code.

### [`opaquePayload`](./network-send.ts#L52)

_Function_

```ts
 * usually drop or queue rather than retry.
 */
export class RecipientNotResolved extends Data.TaggedError(
  "RecipientNotResolved",
)<
```

Brand a raw string as an OpaquePayload.

### [`OpaquePayload`](./network-send.ts#L48)

_TypeAlias_

```ts
}> {}
```

Branded raw-string payload. The send primitive writes the exact
bytes to the recipient socket — no parse, no transform, no validate.
The nominal brand prevents an unwitting caller from passing an
arbitrary `string` where a wire-ready frame is expected; construct
via opaquePayload.

### [`RecipientNotResolved`](./network-send.ts#L72)

_Class_

```ts
// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface BroadcastOptions {
  readonly forConversation?: ConversationId;
  readonly excludeConnectionId?: ConnectionId;
  readonly messageId?: MessageId;
}
```

Recipient address has no live connection. Caller-recoverable —
usually drop or queue rather than retry.

### [`WriteFailed`](./network-send.ts#L83)

_Class_

```ts
  readonly cid: ConnectionId;
```

Socket write failed. The inner Socket.SocketError cause is
preserved so the caller distinguishes a write failure from a
resolution failure without re-running the lookup.

## Files

- `agent-endpoint-resolver.ts`
- `agent-endpoint-resolver.types-check.ts`
- `app-tm-registry.ts`
- `network-send.ts`
