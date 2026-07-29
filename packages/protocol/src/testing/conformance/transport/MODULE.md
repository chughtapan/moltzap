# protocol/testing/conformance/transport

_`packages/protocol/src/testing/conformance/transport`_

## Purpose

Public barrel for transport-layer conformance properties.

Transport-layer conformance properties.

Lifecycle transport invariants — adversity around latency,
connection-reset, timeout, and close.

Each `register*` lives in its own file. This barrel re-exports them
by name AND aggregates them into `TRANSPORT_PROPERTIES` for the
`_shared/suite.ts` aggregator.

## Public surface

### [`acquireProxiedClient`](./_helpers.ts#L57)

_Function_

```ts
export function acquireProxiedClient(opts: {
  readonly ctx: ConformanceRunContext;
  readonly proxy: ToxiproxyProxy;
  readonly name: string;
  readonly defaultTimeoutMs: number;
  readonly unavailable: (reason: string) => PropertyUnavailable;
}): Effect.Effect<
  { agent: TestAgent; client: AgentTestClient },
  PropertyUnavailable,
  Scope.Scope
>
```

Acquire an agent client that routes through the Toxiproxy proxy.

### [`ADVERSITY_CATEGORY`](./_helpers.ts#L24)

_Variable_

```ts
export const ADVERSITY_CATEGORY = "adversity" as const
```

### [`adversityViolation`](./_helpers.ts#L30)

_Function_

```ts
export function adversityViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation
```

### [`attachToxic`](./_helpers.ts#L111)

_Property_

```ts
  readonly attachToxic: Effect.Effect<void, PropertyUnavailable, Scope.Scope>;
```

### [`createOneOnOneConversation`](./_helpers.ts#L216)

_Function_

```ts
export function createOneOnOneConversation(
  owner: { agent: TestAgent; client: AgentTestClient },
  participant: { agent: TestAgent; client: AgentTestClient },
  propertyName: string,
): Effect.Effect<
  { taskId: TaskId; conversationId: ConversationId },
  PropertyInvariantViolation
>
```

### [`proxy`](./_helpers.ts#L109)

_Property_

```ts
  readonly proxy: ToxiproxyProxy;
```

### [`proxyName`](./_helpers.ts#L48)

_Function_

```ts
export function proxyName(prefix: string, seed: number): string
```

### [`registerLatencyResilience`](./adversity-latency-resilience.ts#L24)

_Function_

```ts
export function registerLatencyResilience(ctx: ConformanceRunContext): void
```

### [`registerResetPeerRecovery`](./adversity-reset-peer-recovery.ts#L27)

_Function_

```ts
export function registerResetPeerRecovery(ctx: ConformanceRunContext): void
```

### [`registerSlowCloseCleanup`](./adversity-slow-close-cleanup.ts#L20)

_Function_

```ts
export function registerSlowCloseCleanup(ctx: ConformanceRunContext): void
```

### [`registerTimeoutSurface`](./adversity-timeout-surface.ts#L23)

_Function_

```ts
export function registerTimeoutSurface(ctx: ConformanceRunContext): void
```

### [`ToxicBodyParams`](./_helpers.ts#L108)

_TypeAlias_

```ts
export type ToxicBodyParams = {
  readonly proxy: ToxiproxyProxy;
  readonly unavailable: (reason: string) => PropertyUnavailable;
  readonly attachToxic: Effect.Effect<void, PropertyUnavailable, Scope.Scope>;
};
```

Body params — `attachToxic` attaches the toxic inside the caller's
scope. Nesting matters: the caller typically does

```ts
Effect.scoped(gen(function* () {
  const client = yield* acquireProxiedClient(...)  // outer
  yield* Effect.scoped(gen(function* () {
    yield* attachToxic                             // inner
    yield* assertion(client)
  }))                                              // toxic removed
}))                                                // client close OK
```

so the toxic is removed BEFORE the agent client's socket close. Under
disruptive toxics (timeout, reset_peer), this lets the WS close
handshake flow cleanly instead of hanging on a black-holed channel.

### [`TRANSPORT_PROPERTIES`](./index.ts#L31)

_Variable_

```ts
export const TRANSPORT_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerLatencyResilience,
  registerResetPeerRecovery,
  registerTimeoutSurface,
  registerSlowCloseCleanup,
]
```

All transport-layer property registrars, in the order
`_shared/suite.ts` invokes them.

### [`unavailable`](./_helpers.ts#L110)

_Property_

```ts
  readonly unavailable: (reason: string) => PropertyUnavailable;
```

### [`withToxicProxy`](./_helpers.ts#L120)

_Function_

```ts
export function withToxicProxy(opts: {
  readonly ctx: ConformanceRunContext;
  readonly propertyName: string;
  readonly description: string;
  readonly proxyName: string;
  readonly profile: ToxicProfile;
  readonly body: (
    params: ToxicBodyParams,
  ) => Effect.Effect<void, ToxicPropertyError, Scope.Scope>;
}): void
```

Factory — wire a Toxiproxy proxy + attach the toxic; hand a body the
proxy. Hard-deadlines each property body so a hanging toxic can't
block the suite indefinitely; if the deadline fires, the property
reports `PropertyUnavailable` (not a pass, not a crash).

## Files

- `_helpers.ts`
- `adversity-latency-resilience.ts`
- `adversity-reset-peer-recovery.ts`
- `adversity-slow-close-cleanup.ts`
- `adversity-timeout-surface.ts`
- `index.ts`
