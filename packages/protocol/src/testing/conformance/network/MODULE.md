# protocol/testing/conformance/network

_`packages/protocol/src/testing/conformance/network`_

## Purpose

Public barrel for network-layer conformance properties.

Network-layer conformance properties.

Connection / presence / subscription invariants. Presence is server-derived
from `LeaseRegistry` lifecycle plus WS connect/disconnect; `presence/subscribe`
returns the current status snapshot. There is no client-driven
`presence/update` RPC.

Each `register*` lives in its own file. This barrel re-exports them
by name AND aggregates them into `NETWORK_PROPERTIES` for the
`_shared/suite.ts` aggregator.

## Public surface

### [`acquireClient`](./_helpers.ts#L63)

_Function_

```ts
export function acquireClient(
  ctx: ConformanceRunContext,
  propertyName: string,
  name: string,
): Effect.Effect<PresenceActor, PropertyInvariantViolation, Scope.Scope>
```

### [`acquireCloseableClient`](./_helpers.ts#L86)

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

### [`NETWORK_PROPERTIES`](./index.ts#L24)

_Variable_

```ts
export const NETWORK_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [registerSubscribeAfterConnect]
```

All network-layer property registrars, in suite walk order.

### [`PRESENCE_CATEGORY`](./_helpers.ts#L17)

_Variable_

```ts
export const PRESENCE_CATEGORY = "presence" as const
```

### [`PRESENCE_DEFAULT_TIMEOUT_MS`](./_helpers.ts#L18)

_Variable_

```ts
export const PRESENCE_DEFAULT_TIMEOUT_MS = 5000
```

### [`PresenceActor`](./_helpers.ts#L29)

_Interface_

```ts
export interface PresenceActor {
  readonly agent: TestAgent;
  readonly client: AgentTestClient;
}
```

### [`PresenceStatus`](./_helpers.ts#L22)

_TypeAlias_

```ts
export type PresenceStatus = "online" | "working" | "offline";
```

### [`PresenceStatusEntry`](./_helpers.ts#L24)

_Interface_

```ts
export interface PresenceStatusEntry {
  readonly agentId: AgentId;
  readonly status: PresenceStatus;
}
```

### [`presenceViolation`](./_helpers.ts#L34)

_Function_

```ts
export function presenceViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation
```

### [`registerAgent`](./_helpers.ts#L45)

_Function_

```ts
export function registerAgent(
  ctx: ConformanceRunContext,
  propertyName: string,
  name: string,
): Effect.Effect<TestAgent, PropertyInvariantViolation>
```

### [`registerSubscribeAfterConnect`](./presence-subscribe-after-connect.ts#L17)

_Function_

```ts
export function registerSubscribeAfterConnect(
  ctx: ConformanceRunContext,
): void
```

## Files

- `_helpers.ts`
- `index.ts`
- `presence-subscribe-after-connect.ts`
