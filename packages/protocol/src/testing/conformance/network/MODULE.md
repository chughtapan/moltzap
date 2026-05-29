# protocol/testing/conformance/network

_`packages/protocol/src/testing/conformance/network`_

## Purpose

Public barrel for network-layer conformance properties.

Network-layer conformance properties.

Connection / presence / subscription invariants — `Connect` lifecycle,
server-derived presence (`PresenceSubscribe` fan-out + `presence/changed`
notifications), reconnect semantics, same-state collapse. Presence is
server-derived from `LeaseRegistry` lifecycle plus WS connect/disconnect;
`PresenceService` implements `LeaseTransitionObserver` and broadcasts
`presence/changed` to subscribers. There is no client-driven
`presence/update` RPC.

Each `register*` lives in its own file. This barrel re-exports them
by name AND aggregates them into `NETWORK_PROPERTIES` for the
`_shared/suite.ts` aggregator.

## Public surface

### [`acquireClient`](./_helpers.ts#L74)

_Function_

```ts
export function acquireClient(
  ctx: ConformanceRunContext,
  propertyName: string,
  name: string,
): Effect.Effect<
  { agent: TestAgent; client: TestClient },
  PropertyInvariantViolation,
  Scope.Scope
>
```

### [`acquireCloseableClient`](./_helpers.ts#L103)

_Function_

```ts
export function acquireCloseableClient(
  ctx: ConformanceRunContext,
  propertyName: string,
  agent: TestAgent,
  label: string,
): Effect.Effect<CloseableTestClient, PropertyInvariantViolation, Scope.Scope>
```

### [`countPresenceChangedFor`](./_helpers.ts#L240)

_Function_

```ts
export function countPresenceChangedFor(
  client: TestClient,
  agentId: AgentId,
): Effect.Effect<number>
```

### [`NETWORK_PROPERTIES`](./index.ts#L40)

_Variable_

```ts
export const NETWORK_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerConnectBroadcast,
  registerDisconnectBroadcast,
  registerReconnectStorm,
  registerSameStateNoDoubleFire,
  registerMultiSubscriberFanOut,
  registerSubscribeAfterConnect,
]
```

All network-layer property registrars in legacy walk order
(mirroring legacy `presence.ts` registration sequence).

### [`PRESENCE_CATEGORY`](./_helpers.ts#L29)

_Variable_

```ts
export const PRESENCE_CATEGORY = "presence" as const
```

### [`PRESENCE_DEFAULT_CAPTURE_CAPACITY`](./_helpers.ts#L31)

_Variable_

```ts
export const PRESENCE_DEFAULT_CAPTURE_CAPACITY = 256
```

### [`PRESENCE_DEFAULT_TIMEOUT_MS`](./_helpers.ts#L30)

_Variable_

```ts
export const PRESENCE_DEFAULT_TIMEOUT_MS = 5000
```

### [`PresenceChangedPayload`](./_helpers.ts#L40)

_Interface_

```ts
export interface PresenceChangedPayload {
  readonly agentId: string;
  readonly status: PresenceStatus;
}
```

### [`PresenceStatus`](./_helpers.ts#L38)

_TypeAlias_

```ts
export type PresenceStatus = "online" | "working" | "offline";

export interface PresenceChangedPayload {
  readonly agentId: string;
  readonly status: PresenceStatus;
}
```

### [`presenceStatusesFor`](./_helpers.ts#L203)

_Function_

```ts
export function presenceStatusesFor(
  client: TestClient,
  agentId: AgentId,
): Effect.Effect<ReadonlyArray<PresenceStatus>>
```

### [`presenceViolation`](./_helpers.ts#L45)

_Function_

```ts
export function presenceViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation
```

### [`registerAgent`](./_helpers.ts#L56)

_Function_

```ts
export function registerAgent(
  ctx: ConformanceRunContext,
  propertyName: string,
  name: string,
): Effect.Effect<TestAgent, PropertyInvariantViolation>
```

### [`registerConnectBroadcast`](./presence-connect-broadcast.ts#L17)

_Function_

```ts
export function registerConnectBroadcast(ctx: ConformanceRunContext): void
```

### [`registerDisconnectBroadcast`](./presence-disconnect-broadcast.ts#L17)

_Function_

```ts
export function registerDisconnectBroadcast(ctx: ConformanceRunContext): void
```

### [`registerMultiSubscriberFanOut`](./presence-multi-subscriber-fan-out.ts#L19)

_Function_

```ts
export function registerMultiSubscriberFanOut(
  ctx: ConformanceRunContext,
): void
```

### [`registerReconnectStorm`](./presence-reconnect-storm.ts#L23)

_Function_

```ts
export function registerReconnectStorm(ctx: ConformanceRunContext): void
```

### [`registerSameStateNoDoubleFire`](./presence-same-state-no-double-fire.ts#L26)

_Function_

```ts
export function registerSameStateNoDoubleFire(
  ctx: ConformanceRunContext,
): void
```

### [`registerSubscribeAfterConnect`](./presence-subscribe-after-connect.ts#L17)

_Function_

```ts
export function registerSubscribeAfterConnect(
  ctx: ConformanceRunContext,
): void
```

### [`subscribePresence`](./_helpers.ts#L134)

_Function_

```ts
export function subscribePresence(
  subscriber: TestClient,
  agentId: AgentId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation>
```

### [`waitForPresenceWithStatus`](./_helpers.ts#L159)

_Function_

```ts
export function waitForPresenceWithStatus(
  client: TestClient,
  expected: PresenceChangedPayload,
  propertyName: string,
  timeoutMs: number = PRESENCE_DEFAULT_TIMEOUT_MS,
): Effect.Effect<void, PropertyInvariantViolation>
```

Wait for the next `presence/changed` notification whose payload
matches `expected.agentId` + `expected.status`.

`TestClient.subscribe(def)` filters by descriptor only, so we
consume the broad-union `subscribeAll()` Stream with a per-payload
predicate and timeout it ourselves (#645: replaces the legacy
polling `client.notifications` Stream).

## Files

- `_helpers.ts`
- `index.ts`
- `presence-connect-broadcast.ts`
- `presence-disconnect-broadcast.ts`
- `presence-multi-subscriber-fan-out.ts`
- `presence-reconnect-storm.ts`
- `presence-same-state-no-double-fire.ts`
- `presence-subscribe-after-connect.ts`
