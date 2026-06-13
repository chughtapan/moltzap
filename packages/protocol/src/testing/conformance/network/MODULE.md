# protocol/testing/conformance/network

_`packages/protocol/src/testing/conformance/network`_

## Purpose

Public barrel for network-layer conformance properties.

Network-layer conformance properties.

Connection / presence / subscription invariants — connect lifecycle,
server-derived presence (agent/app subscribe fan-out + presence-changed
notifications), reconnect semantics, same-state collapse. Presence is
server-derived from `LeaseRegistry` lifecycle plus WS connect/disconnect;
`PresenceService` implements `LeaseTransitionObserver` and broadcasts
presence-changed notifications to subscribers. There is no client-driven
`presence/update` RPC.

Each `register*` lives in its own file. This barrel re-exports them
by name AND aggregates them into `NETWORK_PROPERTIES` for the
`_shared/suite.ts` aggregator.

## Public surface

### [`acquireClient`](./_helpers.ts#L200)

_Function_

```ts
export function acquireClient(
  ctx: ConformanceRunContext,
  propertyName: string,
  name: string,
): Effect.Effect<PresenceActor, PropertyInvariantViolation, Scope.Scope>
```

### [`acquireCloseableClient`](./_helpers.ts#L224)

_Function_

```ts
export function acquireCloseableClient(
  ctx: ConformanceRunContext,
  propertyName: string,
  agent: TestAgent,
  label: string,
): Effect.Effect<
  CloseableAgentTestClient,
  PropertyInvariantViolation,
  Scope.Scope
>
```

### [`countPresenceChangedFor`](./_helpers.ts#L343)

_Function_

```ts
export function countPresenceChangedFor(
  actor: PresenceActor,
  agentId: AgentId,
): Effect.Effect<number>
```

### [`NETWORK_PROPERTIES`](./index.ts#L37)

_Variable_

```ts
export const NETWORK_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerConnectBroadcast,
  registerDisconnectBroadcast,
  registerReconnectStorm,
  registerMultiSubscriberFanOut,
  registerSubscribeAfterConnect,
]
```

All network-layer property registrars, in suite walk order.

### [`NotificationBuffer`](./_helpers.ts#L68)

_Interface_

```ts
export interface NotificationBuffer {
  readonly pending: Ref.Ref<ReadonlyArray<NotificationDelivery>>;
  readonly snapshot: Ref.Ref<ReadonlyArray<NotificationDelivery>>;
  readonly closed: Ref.Ref<boolean>;
}
```

Notification buffer feeding `waitForPresenceWithStatus`.
`pending` is a consume-once queue for waits; `snapshot` is append-only
history for sequence/count assertions. The pump fiber that feeds both
refs is interrupted by the `Scope` finalizer installed by
`makeNotificationBuffer`. `closed` flips to true when the transport-side
stream terminates so a waiter on a dead connection fails with a
transport-close diagnostic rather than a generic timeout.

Mirrors `../task/_helpers.ts → NotificationBuffer`; the presence
helper polls with a payload predicate (agentId + status) rather than
by descriptor alone.

### [`PRESENCE_CATEGORY`](./_helpers.ts#L29)

_Variable_

```ts
export const PRESENCE_CATEGORY = "presence" as const
```

### [`PRESENCE_DEFAULT_TIMEOUT_MS`](./_helpers.ts#L30)

_Variable_

```ts
export const PRESENCE_DEFAULT_TIMEOUT_MS = 5000
```

### [`PresenceActor`](./_helpers.ts#L49)

_Interface_

```ts
export interface PresenceActor {
  readonly agent: TestAgent;
  readonly client: AgentTestClient;
  readonly notifications: NotificationBuffer;
}
```

Subscriber actor: an agent client plus the historical
`NotificationBuffer` fed by its `subscribeAll()` pump. `acquireClient`
installs the pump before the subscriber issues `network/presence/subscribe`,
so `waitForPresenceWithStatus` observes every `network/presence-changed` frame
the server broadcasts — including ones that land between the
triggering action and the wait.

### [`PresenceChangedPayload`](./_helpers.ts#L36)

_Interface_

```ts
export interface PresenceChangedPayload {
  readonly agentId: string;
  readonly status: PresenceStatus;
}
```

### [`PresenceStatus`](./_helpers.ts#L34)

_TypeAlias_

```ts
export type PresenceStatus = "online" | "working" | "offline";

export interface PresenceChangedPayload {
  readonly agentId: string;
  readonly status: PresenceStatus;
}
```

### [`presenceStatusesFor`](./_helpers.ts#L324)

_Function_

```ts
export function presenceStatusesFor(
  actor: PresenceActor,
  agentId: AgentId,
): Effect.Effect<ReadonlyArray<PresenceStatus>>
```

### [`presenceViolation`](./_helpers.ts#L171)

_Function_

```ts
export function presenceViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation
```

### [`registerAgent`](./_helpers.ts#L182)

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

### [`registerSubscribeAfterConnect`](./presence-subscribe-after-connect.ts#L17)

_Function_

```ts
export function registerSubscribeAfterConnect(
  ctx: ConformanceRunContext,
): void
```

### [`subscribePresence`](./_helpers.ts#L257)

_Function_

```ts
export function subscribePresence(
  subscriber: AgentTestClient,
  agentId: AgentId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation>
```

### [`waitForPresenceWithStatus`](./_helpers.ts#L287)

_Function_

```ts
export function waitForPresenceWithStatus(
  subscriber: PresenceActor,
  expected: PresenceChangedPayload,
  propertyName: string,
  timeoutMs: number = PRESENCE_DEFAULT_TIMEOUT_MS,
): Effect.Effect<void, PropertyInvariantViolation>
```

Wait for the next `network/presence-changed` notification whose payload
matches `expected.agentId` + `expected.status`.

Polls the subscriber's historical `NotificationBuffer` (fed by the
`subscribeAll()` pump installed at `acquireClient` time) rather than
materialising a fresh `subscribeAll()` Stream inline. The pump
buffers every notification from acquisition onward, so a `network/presence-changed`
that lands between the triggering action and this wait is still
observable. Each match is removed from the buffer, giving sequential
`online → offline → online` waits a consume-once semantic.

## Files

- `_helpers.ts`
- `index.ts`
- `presence-connect-broadcast.ts`
- `presence-disconnect-broadcast.ts`
- `presence-multi-subscriber-fan-out.ts`
- `presence-reconnect-storm.ts`
- `presence-subscribe-after-connect.ts`
