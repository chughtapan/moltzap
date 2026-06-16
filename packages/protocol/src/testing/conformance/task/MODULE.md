# protocol/testing/conformance/task

_`packages/protocol/src/testing/conformance/task`_

## Purpose

Public barrel for task-layer conformance properties.

Task-layer conformance properties.

Task / conversation / message invariants — fan-out cardinality,
store-and-replay, payload opacity, task-boundary isolation,
conversation lifecycle, archive lifecycle, task-close lifecycle.

Each `register*` lives in its own file. This barrel re-exports them
by name AND aggregates them into `TASK_PROPERTIES` for the
`_shared/suite.ts` aggregator.

## Public surface

### [`acquireClient`](./_helpers.ts#L503)

_Function_

```ts
export function acquireClient(
  ctx: ConformanceRunContext,
  name: string,
): Effect.Effect<ConversationActor, string, Scope.Scope>
```

### [`acquireConversation`](./_helpers.ts#L745)

_Function_

```ts
export function acquireConversation(
  ctx: ConformanceRunContext,
  n: number,
  namePrefix: string,
): Effect.Effect<ConversationFixture, string, Scope.Scope>
```

### [`acquirePropertyConversation`](./_helpers.ts#L283)

_Function_

```ts
export function acquirePropertyConversation(
  ctx: ConformanceRunContext,
  propertyName: string,
  namePrefix: string,
): Effect.Effect<ConversationFixture, PropertyInvariantViolation, Scope.Scope>
```

### [`agent`](./_helpers.ts#L77)

_Property_

```ts
  readonly agent: TestAgent;
  readonly client: AgentTestClient;

  /**
   * Per-client historical notification buffer: `subscribe`
   * only emits frames arriving AFTER materialisation, so a sequential
   * `send → awaitOneNotification` races the response frame. The buffer
   * is fed by a long-lived
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
 * every inbound notification arriving on a single client's
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

### [`archiveConversation`](./_helpers.ts#L321)

_Function_

```ts
export function archiveConversation(
  moderatorClient: AppTestClient,
  taskId: TaskId,
  conversationId: ConversationId,
)
```

### [`assertConversationRejectsMessages`](./_helpers.ts#L462)

_Function_

```ts
export function assertConversationRejectsMessages(
  input: AssertConversationRejectsMessagesInput,
): Effect.Effect<void, PropertyInvariantViolation>
```

### [`AssertConversationRejectsMessagesInput`](./_helpers.ts#L454)

_Interface_

```ts
export interface AssertConversationRejectsMessagesInput {
  readonly actor: ConversationActor;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly propertyName: string;
  readonly expectedError?: { readonly tag: string };
}
```

### [`awaitOneNotification`](./_helpers.ts#L251)

_Function_

```ts
export function awaitOneNotification<D extends AnyNotificationDefinition>(
  buffer: NotificationBuffer,
  definition: D,
  timeoutMs: number,
): Effect.Effect<NotificationDelivery<D>, string>
```

Stream-based one-shot waiter for protocol-side conformance helpers.

Consumes the per-client historical `NotificationBuffer` populated by
the `subscribeAll()` pump installed at `acquireClient` time, so
sequential `send → awaitOneNotification` patterns observe frames that
arrived between the triggering RPC and the wait. Mirrors
`@moltzap/server-core/test-utils → awaitOneNotification`.

Surfaces a single string message on either timeout or stream
exhaustion, so call sites use an `e.message`-style error mapper without
a tagged error type per definition.

### [`client`](./_helpers.ts#L78)

_Property_

```ts
  readonly client: AgentTestClient;

  /**
   * Per-client historical notification buffer: `subscribe`
   * only emits frames arriving AFTER materialisation, so a sequential
   * `send → awaitOneNotification` races the response frame. The buffer
   * is fed by a long-lived
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
 * every inbound notification arriving on a single client's
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

### [`CONVERSATION_FAMILY_PROPERTIES`](./conversation-family.ts#L479)

_Variable_

```ts
export const CONVERSATION_FAMILY_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerTaskCreate,
  registerTaskRequestReject,
  registerTaskLeave,
  registerConversationCreateAndList,
]
```

### [`ConversationActor`](./_helpers.ts#L76)

_TypeAlias_

```ts
export type ConversationActor = {
  readonly agent: TestAgent;
  readonly client: AgentTestClient;

  /**
   * Per-client historical notification buffer: `subscribe`
   * only emits frames arriving AFTER materialisation, so a sequential
   * `send → awaitOneNotification` races the response frame. The buffer
   * is fed by a long-lived
   * `subscribeAll()` pump installed at `acquireClient` time;
   * `awaitOneNotification` consumes the buffer so frames that arrived
   * between the triggering RPC and the wait are still observable. This
   * mirrors `@moltzap/server-core/test-utils → connectTestClient` (the
   * `makeNotificationBuffer` JSDoc below covers the design).
   */
  readonly notifications: NotificationBuffer;
};
```

### [`ConversationFixture`](./_helpers.ts#L60)

_Interface_

```ts
export interface ConversationFixture {
  readonly owner: ConversationActor;
  readonly participants: ReadonlyArray<ConversationActor>;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;

  /**
   * The app-principal `AppConnection` bound as the conversation's
   * moderator. App-admin RPCs (archive, unarchive, addParticipant,
   * removeParticipant, close) head their `requires` with `AppPrincipal`, so
   * they route through THIS client, not the agent `owner`. `owner` (an agent)
   * drives `agent/task/request` + `agent/message/send`.
   */
  readonly moderatorClient: AppTestClient;
}
```

### [`DELIVERY_CATEGORY`](./_helpers.ts#L55)

_Variable_

```ts
export const DELIVERY_CATEGORY = "delivery" as const
```

### [`DELIVERY_DEFAULT_PROPERTY_NUM_RUNS`](./_helpers.ts#L57)

_Variable_

```ts
export const DELIVERY_DEFAULT_PROPERTY_NUM_RUNS = 3
```

### [`DELIVERY_DEFAULT_TIMEOUT_MS`](./_helpers.ts#L56)

_Variable_

```ts
export const DELIVERY_DEFAULT_TIMEOUT_MS = 5000
```

### [`deliveryViolation`](./_helpers.ts#L227)

_Function_

```ts
export function deliveryViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation
```

### [`firstParticipant`](./_helpers.ts#L293)

_Function_

```ts
export function firstParticipant(
  fixture: ConversationFixture,
  propertyName: string,
): Effect.Effect<ConversationActor, PropertyInvariantViolation>
```

### [`fixtureN`](./_helpers.ts#L279)

_Function_

```ts
export function fixtureN(requested: number): number
```

### [`moderateAs`](./_helpers.ts#L714)

_Function_

```ts
export function moderateAs(
  ctx: ConformanceRunContext,
  owner: ConversationActor,
  namePrefix: string,
): Effect.Effect<ModeratedHandle, string, Scope.Scope>
```

Wire a SEPARATE app principal as moderator: HTTP-register the manifest
+ `appKey`-Connect an `AppTestClient` whose implicit registration binds it
as the app's moderator endpoint. The grant-all `DispatchAuthorize` +
accept `TaskCreate` + forward-all `MessagesAuthorize` callbacks run on
THAT app connection (all are server-initiated, app-principal
round-trips). The agent `owner` drives `agent/task/request` + `agent/message/send`.

Participant tracking stays on `owner.client` (an agent + conversation
participant): the `app/conversation/created` + participants/added/removed
notifications are agent broadcasts that CANNOT reach an `AppConnection`.
The shared in-process `participantsRef` bridges the owner's subscriber to
the app's forward-all callback.

### [`ModeratedHandle`](./_helpers.ts#L678)

_Interface_

```ts
export interface ModeratedHandle {
  readonly appId: Schema.Schema.Type<typeof AppIdSchema>;

  /**
   * The app-principal `AppConnection` bound as moderator. App-admin RPCs (their
   * `requires` head is `AppPrincipal`) route through this client.
   */
  readonly client: AppTestClient;

  /**
   * Block until the moderator has observed `expectedAgentIds` as
   * participants of `conversationId` via
   * `app/conversation/updateed` notifications. Bridges
   * the gap between the create RPC returning and the notification
   * arriving on the moderator's subscriber.
   */
  readonly awaitConversationReady: (
    conversationId: ConversationId,
    expectedAgentIds: ReadonlyArray<Schema.Schema.Type<typeof AgentId>>,
  ) => Effect.Effect<void, string>;
}
```

### [`NotificationBuffer`](./_helpers.ts#L107)

_Interface_

```ts
export interface NotificationBuffer {
  readonly snapshot: Ref.Ref<
    ReadonlyArray<NotificationDelivery<AnyNotificationDefinition>>
  >;
  readonly closed: Ref.Ref<boolean>;
}
```

Historical notification buffer used by `awaitOneNotification`. Holds
every inbound notification arriving on a single client's
`subscribeAll()` Stream until a consumer pulls a matching frame.

The `snapshot` and `closed` fields are the only public surfaces;
the pump fiber that feeds them is interrupted by the enclosing
Scope finalizer installed by `makeNotificationBuffer`. `closed` is
set to true when the transport-side stream terminates (either via
`TransportClosedError` or normal exhaustion); `awaitOneNotification`
consumes it to surface "Connection closed" rather than masquerading
a missing notification as a timeout.

### [`notifications`](./_helpers.ts#L91)

_Property_

```ts
  readonly notifications: NotificationBuffer;
};

/**
 * Historical notification buffer used by `awaitOneNotification`. Holds
 * every inbound notification arriving on a single client's
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

Per-client historical notification buffer: `subscribe`
only emits frames arriving AFTER materialisation, so a sequential
`send → awaitOneNotification` races the response frame. The buffer
is fed by a long-lived
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

### [`registerConversationCreateAndList`](./conversation-family.ts#L433)

_Function_

```ts
export function registerConversationCreateAndList(
  ctx: ConformanceRunContext,
): void
```

### [`registerConversationLifecycle`](./conversation-lifecycle.ts#L34)

_Function_

```ts
export function registerConversationLifecycle(
  ctx: ConformanceRunContext,
): void
```

### [`registerFanOutCardinality`](./fan-out-cardinality.ts#L28)

_Function_

```ts
export function registerFanOutCardinality(ctx: ConformanceRunContext): void
```

### [`registerPayloadOpacity`](./payload-opacity.ts#L21)

_Function_

```ts
export function registerPayloadOpacity(ctx: ConformanceRunContext): void
```

### [`registerStoreAndReplay`](./store-and-replay.ts#L31)

_Function_

```ts
export function registerStoreAndReplay(ctx: ConformanceRunContext): void
```

### [`registerTaskBoundaryIsolation`](./task-boundary-isolation.ts#L56)

_Function_

```ts
export function registerTaskBoundaryIsolation(
  ctx: ConformanceRunContext,
): void
```

### [`registerTaskCloseLifecycle`](./task-close-lifecycle.ts#L35)

_Function_

```ts
export function registerTaskCloseLifecycle(ctx: ConformanceRunContext): void
```

### [`registerTaskCreate`](./conversation-family.ts#L125)

_Function_

```ts
export function registerTaskCreate(ctx: ConformanceRunContext): void
```

### [`registerTaskLeave`](./conversation-family.ts#L338)

_Function_

```ts
export function registerTaskLeave(ctx: ConformanceRunContext): void
```

### [`registerTaskRequestReject`](./conversation-family.ts#L263)

_Function_

```ts
export function registerTaskRequestReject(ctx: ConformanceRunContext): void
```

### [`sendText`](./_helpers.ts#L305)

_Function_

```ts
export function sendText(
  actor: ConversationActor,
  taskId: TaskId,
  conversationId: ConversationId,
  text: string,
)
```

### [`TASK_PROPERTIES`](./index.ts#L51)

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
  ...CONVERSATION_FAMILY_PROPERTIES,
]
```

All task-layer property registrars: delivery subset first, then the
`app/conversation/*` family.

### [`unarchiveConversation`](./_helpers.ts#L333)

_Function_

```ts
export function unarchiveConversation(
  moderatorClient: AppTestClient,
  taskId: TaskId,
  conversationId: ConversationId,
)
```

### [`waitForArchivedEvent`](./_helpers.ts#L397)

_Function_

```ts
export function waitForArchivedEvent(
  observer: ConversationActor,
  conversationId: ConversationId,
  _byAgentId: AgentId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation>
```

### [`waitForConversationCreatedNotification`](./_helpers.ts#L345)

_Function_

```ts
export function waitForConversationCreatedNotification(
  observer: ConversationActor,
  conversationId: ConversationId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation>
```

### [`waitForMessageReceivedNotification`](./_helpers.ts#L371)

_Function_

```ts
export function waitForMessageReceivedNotification(
  observer: ConversationActor,
  conversationId: ConversationId,
  propertyName: string,
): Effect.Effect<void, PropertyInvariantViolation>
```

### [`waitForUnarchivedEvent`](./_helpers.ts#L427)

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
- `conversation-family.ts`
- `conversation-lifecycle.ts`
- `fan-out-cardinality.ts`
- `index.ts`
- `payload-opacity.ts`
- `store-and-replay.ts`
- `task-boundary-isolation.ts`
- `task-close-lifecycle.ts`
