# protocol/testing/conformance/transport

_`packages/protocol/src/testing/conformance/transport`_

## Purpose

Public barrel for transport-layer conformance properties.

Transport-layer conformance properties.

Wire-level invariants — frame schemas, RPC dispatch primitives,
adversity (latency / framing / connection-reset / timeout / close).

Each `register*` lives in its own file. This barrel re-exports them
by name AND aggregates them into `TRANSPORT_PROPERTIES` for the
`_shared/suite.ts` aggregator.

## Public surface

### [`acquireProxiedClient`](./_helpers.ts#L61)

_Function_

```ts
export function acquireProxiedClient(opts: {
  readonly ctx: ConformanceRunContext;
  readonly proxy: ToxiproxyProxy;
  readonly name: string;
  readonly defaultTimeoutMs: number;
  readonly unavailable: (reason: string) => PropertyUnavailable;
}): Effect.Effect<
  { agent: TestAgent; client: TestClient },
  PropertyUnavailable,
  Scope.Scope
>
```

Acquire a TestClient that routes through the Toxiproxy proxy.

### [`ADVERSITY_CATEGORY`](./_helpers.ts#L27)

_Variable_

```ts
export const ADVERSITY_CATEGORY = "adversity" as const
```

### [`adversityViolation`](./_helpers.ts#L34)

_Function_

```ts
export function adversityViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation
```

### [`attachToxic`](./_helpers.ts#L115)

_Property_

```ts
  readonly attachToxic: Effect.Effect<void, PropertyUnavailable, Scope.Scope>;
```

### [`createOneOnOneConversation`](./_helpers.ts#L220)

_Function_

```ts
export function createOneOnOneConversation(
  owner: { agent: TestAgent; client: TestClient },
  participant: { agent: TestAgent; client: TestClient },
  propertyName: string,
): Effect.Effect<
  { taskId: TaskId; conversationId: ConversationId },
  PropertyInvariantViolation
>
```

### [`DEFAULT_CAPTURE_CAPACITY`](./_helpers.ts#L28)

_Variable_

```ts
export const DEFAULT_CAPTURE_CAPACITY = 128
```

### [`proxy`](./_helpers.ts#L113)

_Property_

```ts
  readonly proxy: ToxiproxyProxy;
```

### [`proxyName`](./_helpers.ts#L52)

_Function_

```ts
export function proxyName(prefix: string, seed: number): string
```

### [`registerCallerControlledAppCallbackTimeout`](./caller-controlled-app-callback-timeout.ts#L41)

_Function_

```ts
export function registerCallerControlledAppCallbackTimeout(
  ctx: ConformanceRunContext,
): void
```

### [`registerLatencyResilience`](./adversity-latency-resilience.ts#L24)

_Function_

```ts
export function registerLatencyResilience(ctx: ConformanceRunContext): void
```

### [`registerMalformedFrameHandling`](./malformed-frame-handling.ts#L26)

_Function_

```ts
export function registerMalformedFrameHandling(
  ctx: ConformanceRunContext,
): void
```

### [`registerNotificationWellFormedness`](./notification-well-formedness.ts#L37)

_Function_

```ts
export function registerNotificationWellFormedness(
  ctx: ConformanceRunContext,
): void
```

### [`registerRequestIdUniqueness`](./request-id-uniqueness.ts#L32)

_Function_

```ts
export function registerRequestIdUniqueness(ctx: ConformanceRunContext): void
```

### [`registerRequestWellFormedness`](./request-well-formedness.ts#L34)

_Function_

```ts
export function registerRequestWellFormedness(
  ctx: ConformanceRunContext,
): void
```

### [`registerResetPeerRecovery`](./adversity-reset-peer-recovery.ts#L28)

_Function_

```ts
export function registerResetPeerRecovery(ctx: ConformanceRunContext): void
```

### [`registerRoundTripIdentity`](./round-trip-identity.ts#L20)

_Function_

```ts
export function registerRoundTripIdentity(ctx: ConformanceRunContext): void
```

### [`registerRpcMapCoverage`](./rpc-map-coverage.ts#L47)

_Function_

```ts
export function registerRpcMapCoverage(ctx: ConformanceRunContext): void
```

### [`registerSchemaExhaustiveFuzz`](./schema-exhaustive-fuzz.ts#L44)

_Function_

```ts
export function registerSchemaExhaustiveFuzz(ctx: ConformanceRunContext): void
```

### [`registerSlicerFraming`](./adversity-slicer-framing.ts#L25)

_Function_

```ts
export function registerSlicerFraming(ctx: ConformanceRunContext): void
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

### [`ToxicBodyParams`](./_helpers.ts#L112)

_TypeAlias_

```ts
export type ToxicBodyParams = {
  readonly proxy: ToxiproxyProxy;
  readonly unavailable: (reason: string) => PropertyUnavailable;
```

Body params — `attachToxic` attaches the toxic inside the caller's
scope. Nesting matters: the caller typically does

  Effect.scoped(gen(function* () {
    const client = yield* acquireProxiedClient(...)  // outer
    yield* Effect.scoped(gen(function* () {
      yield* attachToxic                             // inner
      yield* assertion(client)
    }))                                              // toxic removed
  }))                                                // client close OK

so the toxic is removed BEFORE TestClient's socket close. Under
disruptive toxics (timeout, reset_peer), this lets the WS close
handshake flow cleanly instead of hanging on a black-holed channel.

### [`TRANSPORT_PROPERTIES`](./index.ts#L52)

_Variable_

```ts
export const TRANSPORT_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerRequestWellFormedness,
  registerNotificationWellFormedness,
  registerRoundTripIdentity,
  registerMalformedFrameHandling,
  registerRpcMapCoverage,
  registerRequestIdUniqueness,
  registerCallerControlledAppCallbackTimeout,
  registerLatencyResilience,
  registerSlicerFraming,
  registerResetPeerRecovery,
  registerTimeoutSurface,
  registerSlowCloseCleanup,
  registerSchemaExhaustiveFuzz,
]
```

All transport-layer property registrars, in the order
`_shared/suite.ts` invokes them. Order matches the legacy
`registerAllProperties` walk for byte-equivalent baseline output:
schema-conformance subset (5) → rpc-semantics subset (2) →
adversity (5) → boundary subset (1).

### [`unavailable`](./_helpers.ts#L114)

_Property_

```ts
  readonly unavailable: (reason: string) => PropertyUnavailable;
```

### [`withToxicProxy`](./_helpers.ts#L124)

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
- `adversity-slicer-framing.ts`
- `adversity-slow-close-cleanup.ts`
- `adversity-timeout-surface.ts`
- `caller-controlled-app-callback-timeout.ts`
- `index.ts`
- `malformed-frame-handling.ts`
- `notification-well-formedness.ts`
- `request-id-uniqueness.ts`
- `request-well-formedness.ts`
- `round-trip-identity.ts`
- `rpc-map-coverage.ts`
- `schema-exhaustive-fuzz.ts`
