# protocol/testing/conformance/task

_`packages/protocol/src/testing/conformance/task`_

## Purpose

Public barrel for task-layer conformance properties.

Task-layer conformance properties.

Task / conversation / message invariants — fan-out cardinality,
store-and-replay, payload opacity, task-boundary isolation,
conversation lifecycle, archive lifecycle, model equivalence,
task-close lifecycle.

Each `register*` lives in its own file. This barrel re-exports them
by name AND aggregates them into `TASK_PROPERTIES` for the
`_shared/suite.ts` aggregator.

## Public surface

### [`acquireClient`](./_helpers.ts#L514)

_Function_

```ts
export function acquireClient(
  ctx: ConformanceRunContext,
  name: string,
): Effect.Effect<ConversationActor, string, Scope.Scope>
```

### [`acquireConversation`](./_helpers.ts#L754)

_Function_

```ts
export function acquireConversation(
  ctx: ConformanceRunContext,
  n: number,
  namePrefix: string,
): Effect.Effect<ConversationFixture, string, Scope.Scope>
```

### [`acquirePropertyConversation`](./_helpers.ts#L284)

_Function_

```ts
export function acquirePropertyConversation(
  ctx: ConformanceRunContext,
  propertyName: string,
  namePrefix: string,
): Effect.Effect<ConversationFixture, PropertyInvariantViolation, Scope.Scope>
```

### [`agent`](./_helpers.ts#L74)

_Property_

```ts
  readonly agent: TestAgent;
  readonly client: TestClient;

  /**
   * Per-client historical notification buffer (#645): the consolidated
   * `TestClient.subscribe` only emits frames arriving AFTER
   * materialisation, so a sequential `send → awaitOneNotification` races
   * the response frame. The buffer is fed by a long-lived
   * `subscribeAll()` pump installed at `acquireClient` time;
   * `awaitOneNotification` consumes the buffer so frames that arrived
   * between the triggering RPC and the wait are still observable. This
   * mirrors `@moltzap/server-core/test-utils → connectTestClient` (the
   * `makeNotificationBuffer` JSDoc below covers the design).
   */
  readonly notifications: NotificationBuffer;
};

/**
 * Historical notification buffer used by `awaitOneNotification`. Holds
 * every inbound notification arriving on a single `TestClient`'s
 * `subscribeAll()` Stream until a consumer pulls a matching frame.
 *
 * The `snapshot` and `closed` fields are the only public surfaces;
 * the pump fiber that feeds them is interrupted by the enclosing
 * Scope finalizer installed by `makeNotificationBuffer`. `closed` is
 * set to true when the transport-side stream terminates (either via
 * `TransportClosedError` or normal exhaustion); `awaitOneNotification`
 * consumes it to surface "Connection closed" rather than masquerading
 * a missing notification as a timeout.
 */
export interface NotificationBuffer {
```

### [`archiveConversation`](./_helpers.ts#L319)

_Function_

```ts
export function archiveConversation(
  actor: ConversationActor,
  taskId: TaskId,
  conversationId: ConversationId,
)
```

### [`assertConversationRejectsMessages`](./_helpers.ts#L470)

_Function_

```ts
export function assertConversationRejectsMessages(
  input: AssertConversationRejectsMessagesInput,
): Effect.Effect<void, PropertyInvariantViolation>
```

### [`AssertConversationRejectsMessagesInput`](./_helpers.ts#L462)

_Interface_

```ts
export interface AssertConversationRejectsMessagesInput {
  readonly actor: ConversationActor;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly propertyName: string;
  readonly expectedError?: { readonly code: number; readonly label: string };
}
```

### [`awaitOneNotification`](./_helpers.ts#L252)

_Function_

```ts
export function awaitOneNotification<D extends AnyNotificationDefinition>(
  buffer: NotificationBuffer,
  definition: D,
  timeoutMs: number,
): Effect.Effect<DecodedNotification<D>, string>
```

Stream-based one-shot waiter for protocol-side conformance helpers.
Replaces the deleted `TestClient.waitForNotification(def, timeoutMs)`
polling shape (#645).

Consumes the per-client historical `NotificationBuffer` populated by
the `subscribeAll()` pump installed at `acquireClient` time, so
sequential `send → awaitOneNotification` patterns observe frames
that arrived between the triggering RPC and the wait — the legacy
polling semantic preserved without resurrecting the deleted
per-definition dedup ring. Mirrors
`@moltzap/server-core/test-utils → awaitOneNotification`.

Surfaces a single string message on either timeout or stream
exhaustion so call sites preserve the legacy `e.message`-style error
mapper without re-deriving a tagged error type per definition.

### [`client`](./_helpers.ts#L75)

_Property_

```ts
  readonly client: TestClient;

  /**
   * Per-client historical notification buffer (#645): the consolidated
   * `TestClient.subscribe` only emits frames arriving AFTER
   * materialisation, so a sequential `send → awaitOneNotification` races
   * the response frame. The buffer is fed by a long-lived
   * `subscribeAll()` pump installed at `acquireClient` time;
   * `awaitOneNotification` consumes the buffer so frames that arrived
   * between the triggering RPC and the wait are still observable. This
   * mirrors `@moltzap/server-core/test-utils → connectTestClient` (the
   * `makeNotificationBuffer` JSDoc below covers the design).
   */
  readonly notifications: NotificationBuffer;
};

/**
 * Historical notification buffer used by `awaitOneNotification`. Holds
 * every inbound notification arriving on a single `TestClient`'s
 * `subscribeAll()` Stream until a consumer pulls a matching frame.
 *
 * The `snapshot` and `closed` fields are the only public surfaces;
 * the pump fiber that feeds them is interrupted by the enclosing
 * Scope finalizer installed by `makeNotificationBuffer`. `closed` is
 * set to true when the transport-side stream terminates (either via
 * `TransportClosedError` or normal exhaustion); `awaitOneNotification`
 * consumes it to surface "Connection closed" rather than masquerading
 * a missing notification as a timeout.
 */
export interface NotificationBuffer {
```

### [`ConversationActor`](./_helpers.ts#L73)

_TypeAlias_

```ts
export type ConversationActor = {
  readonly agent: TestAgent;
  readonly client: TestClient;

  /**
   * Per-client historical notification buffer (#645): the consolidated
   * `TestClient.subscribe` only emits frames arriving AFTER
   * materialisation, so a sequential `send → awaitOneNotification` races
   * the response frame. The buffer is fed by a long-lived
   * `subscribeAll()` pump installed at `acquireClient` time;
   * `awaitOneNotification` consumes the buffer so frames that arrived
   * between the triggering RPC and the wait are still observable. This
   * mirrors `@moltzap/server-core/test-utils → connectTestClient` (the
   * `makeNotificationBuffer` JSDoc below covers the design).
   */
  readonly notifications: NotificationBuffer;
};
```

### [`ConversationFixture`](./_helpers.ts#L66)

_Interface_

```ts
export interface ConversationFixture {
  readonly owner: ConversationActor;
  readonly participants: ReadonlyArray<ConversationActor>;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}
```

### [`DELIVERY_CATEGORY`](./_helpers.ts#L60)

_Variable_

```ts
export const DELIVERY_CATEGORY = "delivery" as const
```

### [`DELIVERY_DEFAULT_CAPTURE_CAPACITY`](./_helpers.ts#L62)

_Variable_

```ts
export const DELIVERY_DEFAULT_CAPTURE_CAPACITY = 256
```

### [`DELIVERY_DEFAULT_PROPERTY_NUM_RUNS`](./_helpers.ts#L63)

_Variable_

```ts
export const DELIVERY_DEFAULT_PROPERTY_NUM_RUNS = 3
```

### [`DELIVERY_DEFAULT_TIMEOUT_MS`](./_helpers.ts#L61)

_Variable_

```ts
export const DELIVERY_DEFAULT_TIMEOUT_MS = 5000
```

### [`deliveryViolation`](./_helpers.ts#L224)

_Function_

```ts
export function deliveryViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation
```

### [`firstParticipant`](./_helpers.ts#L294)

_Function_

```ts
export function firstParticipant(
  fixture: ConversationFixture,
  propertyName: string,
): Effect.Effect<ConversationActor, PropertyInvariantViolation>
```

### [`fixtureN`](./_helpers.ts#L280)

_Function_

```ts
export function fixtureN(requested: number): number
```

### [`moderateAs`](./_helpers.ts#L721)

_Function_

```ts
export function moderateAs(
  owner: ConversationActor,
  namePrefix: string,
): Effect.Effect<ModeratedHandle, string, Scope.Scope>
```

### [`ModeratedHandle`](./_helpers.ts#L705)

_Interface_

```ts
export interface ModeratedHandle {
  readonly appId: Static<typeof AppIdSchema>;

  /**
   * Block until the moderator has observed `expectedAgentIds` as
   * participants of `conversationId` via
   * `task/conversation/participants/added` notifications. Bridges
   * the gap between the create RPC returning and the notification
   * arriving on the moderator's subscriber.
   */
  readonly awaitConversationReady: (
    conversationId: ConversationId,
    expectedAgentIds: ReadonlyArray<Static<typeof AgentId>>,
  ) => Effect.Effect<void, string>;
}
```

### [`NotificationBuffer`](./_helpers.ts#L104)

_Interface_

```ts
export interface NotificationBuffer {
  readonly snapshot: Ref.Ref<
    ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>
  >;
  readonly closed: Ref.Ref<boolean>;
}
```

Historical notification buffer used by `awaitOneNotification`. Holds
every inbound notification arriving on a single `TestClient`'s
`subscribeAll()` Stream until a consumer pulls a matching frame.

The `snapshot` and `closed` fields are the only public surfaces;
the pump fiber that feeds them is interrupted by the enclosing
Scope finalizer installed by `makeNotificationBuffer`. `closed` is
set to true when the transport-side stream terminates (either via
`TransportClosedError` or normal exhaustion); `awaitOneNotification`
consumes it to surface "Connection closed" rather than masquerading
a missing notification as a timeout.

### [`notifications`](./_helpers.ts#L88)

_Property_

```ts
  readonly notifications: NotificationBuffer;
};

/**
 * Historical notification buffer used by `awaitOneNotification`. Holds
 * every inbound notification arriving on a single `TestClient`'s
 * `subscribeAll()` Stream until a consumer pulls a matching frame.
 *
 * The `snapshot` and `closed` fields are the only public surfaces;
 * the pump fiber that feeds them is interrupted by the enclosing
 * Scope finalizer installed by `makeNotificationBuffer`. `closed` is
 * set to true when the transport-side stream terminates (either via
 * `TransportClosedError` or normal exhaustion); `awaitOneNotification`
 * consumes it to surface "Connection closed" rather than masquerading
 * a missing notification as a timeout.
 */
export interface NotificationBuffer {
```

Per-client historical notification buffer (#645): the consolidated
`TestClient.subscribe` only emits frames arriving AFTER
materialisation, so a sequential `send → awaitOneNotification` races
the response frame. The buffer is fed by a long-lived
`subscribeAll()` pump installed at `acquireClient` time;
`awaitOneNotification` consumes the buffer so frames that arrived
between the triggering RPC and the wait are still observable. This
mirrors `@moltzap/server-core/test-utils → connectTestClient` (the
`makeNotificationBuffer` JSDoc below covers the design).

### [`registerArchiveLifecycle`](./archive-lifecycle.ts#L30)

_Function_

```ts
export function registerArchiveLifecycle(ctx: ConformanceRunContext): void
```

### [`registerConversationLifecycle`](./conversation-lifecycle.ts#L34)

_Function_

```ts
export function registerConversationLifecycle(
  ctx: ConformanceRunContext,
): void
```

### [`registerFanOutCardinality`](./fan-out-cardinality.ts#L47)

_Function_

```ts
export function registerFanOutCardinality(ctx: ConformanceRunContext): void
```

### [`registerModelEquivalence`](./model-equivalence.ts#L62)

_Function_

```ts
export function registerModelEquivalence(ctx: ConformanceRunContext): void
```

### [`registerPayloadOpacity`](./payload-opacity.ts#L19)

_Function_

```ts
export function registerPayloadOpacity(ctx: ConformanceRunContext): void
```

### [`registerStoreAndReplay`](./store-and-replay.ts#L43)

_Function_

```ts
export function registerStoreAndReplay(ctx: ConformanceRunContext): void
```

### [`registerTaskBoundaryIsolation`](./task-boundary-isolation.ts#L17)

_Function_

```ts
export function registerTaskBoundaryIsolation(
  ctx: ConformanceRunContext,
): void
```

### [`registerTaskCloseLifecycle`](./task-close-lifecycle.ts#L38)

_Function_

```ts
export function registerTaskCloseLifecycle(ctx: ConformanceRunContext): void
```

### [`registerTaskConversationAddParticipant`](./task-conversation-family.ts#L551)

_Function_

```ts
export function registerTaskConversationAddParticipant(
  ctx: ConformanceRunContext,
): void
```

### [`registerTaskConversationArchiveDenied`](./task-conversation-family.ts#L535)

_Function_

```ts
export function registerTaskConversationArchiveDenied(
  ctx: ConformanceRunContext,
): void
```

### [`registerTaskConversationCreateAndList`](./task-conversation-family.ts#L435)

_Function_

```ts
export function registerTaskConversationCreateAndList(
  ctx: ConformanceRunContext,
): void
```

### [`registerTaskConversationCreateDenied`](./task-conversation-family.ts#L634)

_Function_

```ts
export function registerTaskConversationCreateDenied(
  ctx: ConformanceRunContext,
): void
```

### [`registerTaskConversationRemoveParticipant`](./task-conversation-family.ts#L594)

_Function_

```ts
export function registerTaskConversationRemoveParticipant(
  ctx: ConformanceRunContext,
): void
```

### [`registerTaskCreate`](./task-conversation-family.ts#L138)

_Function_

```ts
export function registerTaskCreate(ctx: ConformanceRunContext): void
```

### [`registerTaskLeave`](./task-conversation-family.ts#L343)

_Function_

```ts
export function registerTaskLeave(ctx: ConformanceRunContext): void
```

### [`registerTaskRequestReject`](./task-conversation-family.ts#L271)

_Function_

```ts
export function registerTaskRequestReject(ctx: ConformanceRunContext): void
```

### [`sendText`](./_helpers.ts#L306)

_Function_

```ts
export function sendText(
  actor: ConversationActor,
  taskId: TaskId,
  conversationId: ConversationId,
  text: string,
)
```

### [`TASK_CONVERSATION_FAMILY_PROPERTIES`](./task-conversation-family.ts#L682)

_Variable_

```ts
export const TASK_CONVERSATION_FAMILY_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerTaskCreate,
  registerTaskRequestReject,
  registerTaskLeave,
  registerTaskConversationCreateAndList,
  registerTaskConversationCreateDenied,
  registerTaskConversationArchiveDenied,
  registerTaskConversationAddParticipant,
  registerTaskConversationRemoveParticipant,
]
```

### [`TASK_PROPERTIES`](./index.ts#L65)

_Variable_

```ts
export const TASK_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerFanOutCardinality,
  registerStoreAndReplay,
  registerPayloadOpacity,
  registerTaskBoundaryIsolation,
  registerConversationLifecycle,
  registerTaskCloseLifecycle,
  registerArchiveLifecycle,
  ...TASK_CONVERSATION_FAMILY_PROPERTIES,
  registerModelEquivalence,
]
```

All task-layer property registrars, ordered per architect plan §2
(delivery subset first, then `model-equivalence` from rpc-semantics).
Spec D1 additions append to the delivery subset.

### [`unarchiveConversation`](./_helpers.ts#L330)

_Function_

```ts
export function unarchiveConversation(
  actor: ConversationActor,
  taskId: TaskId,
  conversationId: ConversationId,
)
```

### [`waitForArchivedEvent`](./_helpers.ts#L396)

_Function_

```ts
export function waitForArchivedEvent(
  observer: ConversationActor,
  conversationId: ConversationId,
  _byAgentId: AgentId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation>
```

### [`waitForConversationCreatedNotification`](./_helpers.ts#L341)

_Function_

```ts
export function waitForConversationCreatedNotification(
  observer: ConversationActor,
  conversationId: ConversationId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation>
```

### [`waitForMessageReceivedNotification`](./_helpers.ts#L369)

_Function_

```ts
export function waitForMessageReceivedNotification(
  observer: ConversationActor,
  conversationId: ConversationId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation>
```

### [`waitForUnarchivedEvent`](./_helpers.ts#L433)

_Function_

```ts
export function waitForUnarchivedEvent(
  observer: ConversationActor,
  conversationId: ConversationId,
  _byAgentId: AgentId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation>
```

## Files

- `_helpers.ts`
- `archive-lifecycle.ts`
- `conversation-lifecycle.ts`
- `fan-out-cardinality.ts`
- `index.ts`
- `model-equivalence.ts`
- `payload-opacity.ts`
- `store-and-replay.ts`
- `task-boundary-isolation.ts`
- `task-close-lifecycle.ts`
- `task-conversation-family.ts`
