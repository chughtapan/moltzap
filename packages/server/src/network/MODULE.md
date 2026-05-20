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

```ts
export type _ConnectionIdLeakCanaryAssertion = _ConnectionIdLeakCanary<true>;
```

### [`AgentEndpointResolver`](./agent-endpoint-resolver.ts#L89)

_Class_

```ts
export class AgentEndpointResolver {
  static readonly make: Effect.Effect<AgentEndpointResolver> = Effect.map(
    Ref.make<ResolverState>(emptyState),
    (state) => new AgentEndpointResolver(state),
  );
```

Multimap of agent → connection ids, plus a reverse index from
connection → agent.

All mutators run inside a single Ref.update so the forward and
reverse views never disagree, even under concurrent add /
remove calls from independent `network/connect` and disconnect
fibers.

### [`AppTmHandler`](./app-tm-registry.ts#L76)

_TypeAlias_

```ts
export type AppTmHandler = (
  payload: OpaquePayload,
) => Effect.Effect<void, never>;
```

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

```ts
export class AppTmRegistry {
  static readonly make: Effect.Effect<AppTmRegistry> = Effect.map(
    Ref.make<HashMap.HashMap<EndpointAddress, AppTmHandler>>(HashMap.empty()),
    (state) => new AppTmRegistry(state),
  );
```

Map-backed registry. `Ref` rather than a plain `Map` so the resolver
stays consistent under concurrent boot-time `register` calls (none
today, but the contract holds for future). Lookups are read-only
snapshots.

### [`connectionId`](./agent-endpoint-resolver.ts#L63)

_Function_

```ts
export const connectionId = (raw: string): ConnectionId
```

Brand a raw connection-id string. Used by the resolver and its callers
(`auth.handlers.ts`, `app/server.ts`) so the maps stay strongly typed.

### [`ConnectionId`](./agent-endpoint-resolver.ts#L57)

_TypeAlias_

```ts
export type ConnectionId = string & Brand.Brand<"ConnectionId">;
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

```ts
export const DEFAULT_DM_TM_ADDRESS: EndpointAddress = brandEndpointAddress(
  "tm:app:00000000-0000-4d11-8000-000000000d11",
)
```

Stable `EndpointAddress` for the default DM TM. Used by
`conversations/create` when the caller does not own a TM and the
conversation type is `dm`. Phase 9b consumer-migration (sub-issue
#460 round 3 R12 + R14): every conversation now belongs to a task
with a registered TM; non-app DMs route through this stable address.

### [`DEFAULT_GROUP_TM_ADDRESS`](./app-tm-registry.ts#L38)

_Variable_

```ts
export const DEFAULT_GROUP_TM_ADDRESS: EndpointAddress = brandEndpointAddress(
  "tm:app:00000000-0000-4691-8000-000000000691",
)
```

Stable `EndpointAddress` for the default group TM. Same role as
DEFAULT_DM_TM_ADDRESS for `type: "group"` conversations.

### [`defaultTmAddressForType`](./app-tm-registry.ts#L49)

_Function_

```ts
export function defaultTmAddressForType(type: "dm" | "group"): EndpointAddress
```

Pick the default TM endpoint for a conversation type. The DM/group
split is preserved as separate addresses (rather than one shared
default) so future differentiation (display semantics, rate limits)
can land without rewiring `tasks.tm_endpoint_address` for existing
rows.

### [`DeliveryAck`](./network-send.ts#L64)

_Class_

```ts
export class DeliveryAck extends Data.TaggedClass("DeliveryAck")<{
  readonly to: EndpointAddress;
}> {}
```

Successful single-recipient write. The fan-out variant
NetworkSendService.broadcast returns the delivered agent ids
in its success channel and absorbs `DeliveryError` cases.

### [`DeliveryError`](./network-send.ts#L88)

_TypeAlias_

```ts
export type DeliveryError = RecipientNotResolved | WriteFailed;
```

### [`NetworkSendService`](./network-send.ts#L111)

_Class_

```ts
export class NetworkSendService {
  constructor(
    private readonly resolver: AgentEndpointResolver,
    private readonly connections: ConnectionManager,
    private readonly appTmRegistry: AppTmRegistry,
  ) {}

  /**
   * Route `payload` to the connection bound to `to`. Dispatches by
   * address kind.
   */
  send(
    to: EndpointAddress,
    payload: OpaquePayload,
  ): Effect.Effect<DeliveryAck, DeliveryError, never> {
    const kind: EndpointAddressKind = endpointAddressKind(to);
    return Match.value(kind).pipe(
      Match.when("agent", () => this.sendToDurableAgent(to, payload)),
      Match.when("app", () => this.sendToAppTm(to, payload)),
      Match.exhaustive,
    );
```

The outbound-routing primitive. Use the constructor directly in code;
route through `NetworkSendServiceTag` in DI-aware code.

### [`opaquePayload`](./network-send.ts#L52)

_Function_

```ts
export const opaquePayload = (raw: string): OpaquePayload
```

Brand a raw string as an OpaquePayload.

### [`OpaquePayload`](./network-send.ts#L48)

_TypeAlias_

```ts
export type OpaquePayload = string & Brand.Brand<"OpaquePayload">;
```

Branded raw-string payload. The send primitive writes the exact
bytes to the recipient socket — no parse, no transform, no validate.
The nominal brand prevents an unwitting caller from passing an
arbitrary `string` where a wire-ready frame is expected; construct
via opaquePayload.

### [`RecipientNotResolved`](./network-send.ts#L72)

_Class_

```ts
export class RecipientNotResolved extends Data.TaggedError(
  "RecipientNotResolved",
)<{
  readonly to: EndpointAddress;
}> {}
```

Recipient address has no live connection. Caller-recoverable —
usually drop or queue rather than retry.

### [`WriteFailed`](./network-send.ts#L83)

_Class_

```ts
export class WriteFailed extends Data.TaggedError("WriteFailed")<{
  readonly to: EndpointAddress;
  readonly cause: Socket.SocketError;
}> {}
```

Socket write failed. The inner Socket.SocketError cause is
preserved so the caller distinguishes a write failure from a
resolution failure without re-running the lookup.

## Files

- `agent-endpoint-resolver.ts`
- `agent-endpoint-resolver.types-check.ts`
- `app-tm-registry.ts`
- `network-send.ts`
