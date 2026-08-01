# protocol/testing/conformance/delivery

_`packages/protocol/src/testing/conformance/delivery`_

## Purpose

Public barrel for delivery-layer conformance properties.

Conversation / message delivery invariants — fan-out cardinality,
store-and-replay, payload opacity.

Each `register*` lives in its own file. This barrel re-exports them
by name AND aggregates them into `DELIVERY_PROPERTIES` for the
`_shared/suite.ts` aggregator.

## Public surface

### [`acquireConversation`](./_helpers.ts#L179)

_Function_

```ts
export function acquireConversation(
  ctx: ConformanceRunContext,
  n: number,
  namePrefix: string,
): Effect.Effect<ConversationFixture, string, Scope.Scope>
```

Executes the acquire conversation operation.

**Returns:** The acquire conversation result.

### [`ConversationActor`](./_helpers.ts#L40)

_Interface_

```ts
export interface ConversationActor {
  readonly agent: TestAgent;
  readonly client: AgentTestClient;

  /**
   * Per-client historical notification buffer: `subscribe`
   * only emits frames arriving AFTER materialisation, so a sequential
   * `send → read snapshot` races the response frame. The buffer
   * is fed by a long-lived
   * `subscribeAll()` pump installed at `acquireClient` time, so frames that
   * arrived between the triggering RPC and the read are still observable.
   * This mirrors `@moltzap/server-core/test-utils → connectTestClient` (the
   * `makeNotificationBuffer` JSDoc below covers the design).
   */
  readonly notifications: NotificationBuffer;
}
```

Describes conversation actor.

### [`ConversationFixture`](./_helpers.ts#L33)

_Interface_

```ts
export interface ConversationFixture {
  readonly owner: ConversationActor;
  readonly participants: readonly ConversationActor[];
  readonly conversationId: ConversationId;
}
```

Describes conversation fixture.

### [`DELIVERY_CATEGORY`](./_helpers.ts#L25)

_Variable_

```ts
export const DELIVERY_CATEGORY = "delivery"
```

Provides the delivery category runtime value.

### [`DELIVERY_DEFAULT_PROPERTY_NUM_RUNS`](./_helpers.ts#L29)

_Variable_

```ts
export const DELIVERY_DEFAULT_PROPERTY_NUM_RUNS = 3
```

Provides the delivery default property num runs runtime value.

### [`DELIVERY_DEFAULT_TIMEOUT_MS`](./_helpers.ts#L27)

_Variable_

```ts
export const DELIVERY_DEFAULT_TIMEOUT_MS = 5000
```

Provides the delivery default timeout ms runtime value.

### [`DELIVERY_PROPERTIES`](./index.ts#L25)

_Variable_

```ts
export const DELIVERY_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [registerFanOutCardinality, registerStoreAndReplay, registerPayloadOpacity]
```

All delivery-layer property registrars.

### [`deliveryViolation`](./_helpers.ts#L131)

_Function_

```ts
export function deliveryViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation
```

Executes the delivery violation operation.

**Returns:** The delivery violation result.

### [`fixtureN`](./_helpers.ts#L147)

_Function_

```ts
export function fixtureN(requested: number): number
```

Executes the fixture n operation.

**Returns:** The fixture n result.

### [`NotificationBuffer`](./_helpers.ts#L67)

_Interface_

```ts
export interface NotificationBuffer {
  readonly snapshot: Ref.Ref<
    ReadonlyArray<NotificationDelivery<AnyNotificationDefinition>>
  >;
  readonly closed: Ref.Ref<boolean>;
}
```

Historical notification buffer. Holds every inbound notification arriving
on a single client's `subscribeAll()` Stream.

The `snapshot` and `closed` fields are the only public surfaces;
the pump fiber that feeds them is interrupted by the enclosing
Scope finalizer installed by `makeNotificationBuffer`. `closed` is
set to true when the transport-side stream terminates (either via
`TransportClosedError` or normal exhaustion).

### [`registerFanOutCardinality`](./fan-out-cardinality.ts#L35)

_Function_

```ts
export function registerFanOutCardinality(ctx: ConformanceRunContext): void
```

Registers fan out cardinality.

### [`registerPayloadOpacity`](./payload-opacity.ts#L31)

_Function_

```ts
export function registerPayloadOpacity(ctx: ConformanceRunContext): void
```

Registers payload opacity.

### [`registerStoreAndReplay`](./store-and-replay.ts#L35)

_Function_

```ts
export function registerStoreAndReplay(ctx: ConformanceRunContext): void
```

Registers store and replay.

## Files

- `_helpers.ts`
- `fan-out-cardinality.ts`
- `index.ts`
- `payload-opacity.ts`
- `store-and-replay.ts`
