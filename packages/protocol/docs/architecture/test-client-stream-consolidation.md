# 12 — TestClient Stream consolidation (Spec B obsolete-code remediation, #645)

Spec B (#596) consolidated the **production** notification surface onto a
typed `Stream.async`-backed registry (`MoltZapAgentClient.subscribe` /
`subscribeAll`). The Non-goals row 2 of #596 explicitly preserved the
protocol-side `TestClient`'s polling shape (`waitForNotification`,
`drainNotifications`, `notifications` queue). Per
`feedback_no_defer_finish_in_impl` (2026-05-19) that deferral is
retroactively non-compliant: the preserved polling surface forces ~169
LOC of bridge code across `@moltzap/protocol`, `@moltzap/server-core`,
and `@moltzap/client` test-utils. This flow consolidates the test
driver onto the same Stream-registry shape the production client
already uses.

## 1. What changes

Before (polling):

```
TestClient                    helpers.ts (per-client)         conformance-adapter.ts
  notifications: Stream<...>  --[5ms poll loop +              [3-field grammar
  drainNotifications: Eff<…>     dedup ring (helperBuffer)]    → 5 inline helpers
  waitForNotification(def,                                       reconstructing
    timeoutMs)                                                   SubscriptionFilter]
       │
       └── reads runtime.notificationQueue: Ref<Array<DecodedNotification>>
           appended by handleNotificationFrame on every inbound frame
```

After (registry + Stream):

```
TestClient                            (registry owned by TestClientRuntime)
  subscribe<D>(def, refinement?)      ↑   TestSubscriberRegistry
    → Stream<DecodedNotification<D>,  │     register / registerAll
              TransportClosedError>   │     dispatch(frame)
  subscribeAll(refinement?)           │     closeAll
    → Stream<DecodedNotification<any>,│
              TransportClosedError>   │
       │                              │
       └── Stream.async source ───────┘
           emit.single from registry.dispatch
           emit.fail   from registry.closeAll (terminal close)
```

The test driver's registry is a leaner mirror of the production registry
(`packages/client/src/runtime/subscribers.ts`): same dispatch shape,
same AD1 snapshot semantic, same `Stream.async` consumer wiring. Error
channel is `TransportClosedError` (the test driver's analog to
production's `NotConnectedError`).

## 2. Why the registry can't be shared

`@moltzap/protocol` is the leaf workspace package; it cannot import
from `@moltzap/client`. Hoisting `makeSubscriberRegistry` into protocol
would require dragging `NotConnectedError` (a client-package concept)
into the leaf, or parameterising the registry by error type. The test
driver needs ~80 LOC of registry code regardless; a parameterised
shared registry would cost roughly the same after carrying through
two error tags, two `Stream.async` wrappers, and divergent
`subscribeAll` semantics. We duplicate **shape**, not behaviour: any
change to AD1 snapshot semantics must update both registries (see §7
risks).

The test registry is intentionally smaller than production: no
broad-union `subscribeAllRef` storage in addition to per-definition,
because the test driver doesn't carry a service-wide fan-out fiber the
way `MoltZapService` does. `subscribeAll` is exposed on `TestClient`
but routes through the same `subsRef` snapshot with a sentinel match-all
predicate; this keeps the dispatch loop a single iteration over one
list.

## 3. The three deletion targets

| # | Module → symbols | LOC | Reason it existed |
|---|---|---|---|
| 1 | `packages/server/src/test-utils/helpers.ts → helperBuffer + pullOneMatching + makeSubscribeStream + NotificationBuffer + SUBSCRIBE_POLL_INTERVAL_MS` | ~95 | Per-`ServerTestClient` dedup ring + 5ms polling loop re-queueing unmatched frames so concurrent `subscribeTo(A)` + `subscribeTo(B)` couldn't race-lose chunk siblings |
| 2 | `packages/client/src/test-utils/conformance-adapter.ts → notificationMatchesFilter + refinementFromRealClientFilter + asNotificationParamsRecord + tagMatches + conversationMatches` | ~74 | Inline reconstruction of the deleted three-field `SubscriptionFilter` grammar so the conformance suite's `RealClientNotificationFilter` could ride on `MoltZapAgentClient.subscribeAll` |
| 3 | `packages/protocol/src/testing/conformance/_shared/driver/test-client.ts → waitForNotification + drainNotifications + notifications queue + appendNotification + takeNotification + pollNotification + pullNotifications + makeNotificationsStream + failIfClosedWhileWaiting + NotificationWaitError + NotificationQueue type + DEFAULT_WAIT_FOR_NOTIFICATION_TIMEOUT_MS + POLL_INTERVAL_MS` | ~115 | Root cause: polling-shaped protocol-side test API preserved per spec #596 Non-goals row 2 |

All three rows collapse together: row 3 going Stream-shaped makes
row 1's dedup ring unnecessary (Stream.async preserves chunk siblings
via per-definition emit) and makes row 2's filter reconstruction
unnecessary (conformance suite's `RealClientNotificationFilter`
collapses to a single predicate function that passes through directly).

### Historical-buffer bridge for integration tests

Spec B's `Stream.async`-backed subscription only emits frames that
arrive AFTER materialisation. The integration-test pattern
`send → awaitOneNotification` (and the dispatch-driver pattern
`requestDispatch → waitForRelease → advanceTime →
waitForObservability`) implicitly depended on the deleted
polling-shape's historical-buffer semantic — frames arriving between
the triggering RPC and the subscription pull were lost on the new
surface, racing tests to timeout.

Three bridges restore the legacy semantic on top of the Stream surface
without resurrecting the per-definition dedup ring:

- **`@moltzap/server-core/test-utils → connectTestClient`** installs a
  per-client broad-union `subscribeAll()` pump at handle creation that
  appends every inbound notification to a `Ref<ReadonlyArray<...>>`
  snapshot. `subscribeTo<D>(def)` (consumed by `awaitOneNotification`)
  polls this snapshot for the first matching frame and removes it,
  preserving historical-buffer semantics for arbitrary
  per-test-fixture definitions.
- **`packages/protocol/.../app/_driver.ts`** installs per-handle
  queue pumps for the three specific dispatch-admission definitions
  (`DispatchRelease`, `DispatchesConsumed`, `DispatchesExpired`) at
  `buildRecipientHandle` / `buildModeratorHandle` time;
  `waitForRelease` / `waitForObservability` consume from these
  per-definition Queues with the legacy match-loop predicate.
- **`packages/protocol/.../task/_helpers.ts → makeNotificationBuffer`**
  installs a per-conformance-actor broad-union `subscribeAll()` pump at
  `acquireClient` time that appends every inbound notification to a
  `Ref<ReadonlyArray<...>>` snapshot bound to the actor's
  `notifications` field. `awaitOneNotification(buffer, definition,
  timeoutMs)` polls this snapshot for the first matching frame and
  removes it. Mirrors the server-core bridge for conformance properties
  that exercise the `RPC → wait-for-N-notifications` pattern (e.g.
  `delivery/conversation-lifecycle`, `delivery/task-close-lifecycle`)
  where one RPC fans out multiple notifications and the test waits for
  them sequentially.

All three bridges live exclusively at the integration-test layer; the
protocol-side `TestClient` itself stays pure-Stream and matches the
production `MoltZapAgentClient` lifecycle exactly.

## 4. Lifecycle parity with production

The test driver mirrors the production `Stream.async` lifecycle
contract (Spec B "Stream lifecycle contract" rows 1-5):

| Phase | Production (`MoltZapAgentClient`) | Test driver (`TestClient`) |
|---|---|---|
| Construction | `subscribe(def, refinement?)` returns Stream value; pure | Same |
| Materialisation | `Stream.async` register installs registry callbacks | Same |
| Pre-connect pull | Consumer pulls suspend inside `Stream.async`'s queue | Same |
| Dispatch | `registry.dispatch(frame)` from `handleDecodedNotification`; snapshots `subsRef` at iteration start | `registry.dispatch(notification)` from `handleNotificationFrame`; same AD1 snapshot semantic |
| Terminal close | `client.close()` → `subscribers.closeAll` → `emit.fail(NotConnectedError)` to every in-flight Stream | `TestClient.close` → registry.closeAll runs as Scope finalizer (LIFO before socket reader); `emit.fail(TransportClosedError)` to every in-flight Stream |

The registry is acquired AFTER the socket inside
`acquireTestClientRuntime` so its `Effect.addFinalizer(closeAll)` runs
**before** the socket scope tears down. Consumers see
`TransportClosedError` via `emit.fail`; their `Stream.async`
cancellation finalizer chain then runs `registry.unregister`; only
then does the socket reader finalizer fire. This is the same
"interrupt subscribers first, tear transport second" ordering that
`composeServiceTeardown` enforces between `MoltZapService.scope` and
`MoltZapAgentClient.close()`.

## 5. RealClientNotificationFilter collapse

The conformance suite's `RealClientNotificationFilter` previously
carried three optional fields (`emissionTag`, `conversationId`,
`notificationNamePrefix`) that the adapter inlined back into a
predicate. The only call site that produces a filter
(`_fixtures.ts → subscribeAll`) passes `{}` (match-all). The type
collapses to a predicate alias:

```ts
// Before
export interface RealClientNotificationFilter {
  readonly emissionTag?: string;
  readonly conversationId?: string;
  readonly notificationNamePrefix?: string;
}

// After
export type RealClientNotificationFilter = (
  notification: DecodedNotification<AnyNotificationDefinition>,
) => boolean;
```

`RealClientNotificationSubscriber.subscribe` takes
`filter?: RealClientNotificationFilter` (predicate optional;
match-all when absent). The adapter plumbs the predicate through to
`MoltZapAgentClient.subscribeAll(refinement)` with no inline
reconstruction. Channel re-exports
(`@moltzap/openclaw-channel/test-support`,
`@moltzap/nanoclaw-channel/test-support`) inherit the simpler shape.

## 6. Migration recipe for protocol-side conformance helpers

The conformance helpers in
`packages/protocol/src/testing/conformance/{task,network,app}/` use
two polling-shape forms today. The right Stream-form replacement
depends on whether the call site relies on historical-buffer semantics
(see §3): notifications that may have arrived between the triggering
RPC and the wait.

```ts
// Before — typed-payload wait by descriptor; the polling shape
// implicitly buffered notifications that arrived before the wait.
yield* client.waitForNotification(SomeNotification, 5_000);

// After — historical-buffer-preserving (RECOMMENDED for
// `send → wait` patterns). Routes through the per-actor
// NotificationBuffer installed by `acquireClient` in
// `task/_helpers.ts`. The buffer feeds frames that arrived between
// the triggering RPC and this wait, eliminating sequential races
// like `tasks/close` → wait `archived` → wait `task/closed` where
// the second wait would otherwise miss an already-dispatched frame.
yield* awaitOneNotification(actor.notifications, SomeNotification, 5_000);

// After — no-buffer (only when the caller pre-subscribes before
// the triggering RPC, e.g. `subscribe → trigger → assert`). Race-
// prone for sequential `trigger → wait` patterns; prefer the
// historical-buffer form above for new sites.
yield* client.subscribe(SomeNotification).pipe(
  Stream.runHead,
  Effect.timeoutFail({
    duration: Duration.millis(5_000),
    onTimeout: () => new NotificationWaitError({ ... }),
  }),
);
```

```ts
// Before — broad-union filter + predicate on params
client.notifications.pipe(
  Stream.filter(framePredicate),
  Stream.runHead,
  ...
)

// After
client.subscribeAll().pipe(
  Stream.filter(framePredicate),
  Stream.runHead,
  ...
)
```

The error channel widens from `TransportClosedError` to
`TransportClosedError` (unchanged) on `subscribe` / `subscribeAll`;
the polling-shape's `NotificationWaitError` is deleted alongside
`waitForNotification`. Sites that need a tagged wait-timeout error
construct it from `Effect.timeoutFail` at the call site (matches the
existing `helpers.ts → AwaitNotificationTimeoutError` pattern that
Spec B already introduced for `awaitOneNotification`).

## 7. Risks + mitigations

- **AD1 snapshot drift between two registries.** Future changes to
  the AD1 semantic (concurrent unregister mid-dispatch observability)
  must update both registries. Mitigation: cross-link this doc from
  `packages/client/docs/architecture/notification-subscription.md →
  AD1 snapshot semantic` and add an explicit cross-reference comment
  at both `dispatch` implementations.
- **Channel test-support re-exports.** `@moltzap/openclaw-channel/test-support`
  and `@moltzap/nanoclaw-channel/test-support` re-export
  `createMoltZapRealClientFactory` directly; they inherit the
  simplified filter type automatically. No channel-side code change.
- **`RealClientNotificationFilter` consumers outside the workspace.**
  `moltzap-arena` consumes the conformance suite via npm
  (`@moltzap/protocol`). The filter type breaking-changes; arena's
  copy of the conformance template at `ARCHITECTURE.md →
  Client-side conformance wrapper template (AC22)` passes no filter
  (uses `subscribe({})`-equivalent), so the change is source-compatible
  after a single template update. Documented in CHANGELOG BREAKING
  entry.
- **`TransportClosedError` vs `NotConnectedError` error channel on
  test-side subscribe.** Production callers expect
  `NotConnectedError`; test callers expect `TransportClosedError`.
  Test sites that fork production-shaped code (e.g. conformance
  fixtures) need to keep these channels straight. Mitigation:
  `TestClient.subscribe` keeps the existing `TransportClosedError`
  channel that `TestClient.notifications` already exposed; no caller
  observes a new error type.

## 8. Symbol map

NEW (added):

- `packages/protocol/src/testing/conformance/_shared/driver/test-subscribers.ts`
  - `TestSubscriberRegistry` (interface)
  - `makeTestSubscriberRegistry()` (constructor)
  - `subscribe(registry, definition, refinement?)` (Stream factory)
  - `subscribeAll(registry, refinement?)` (Stream factory)
- `packages/protocol/src/testing/conformance/task/_helpers.ts`
  - `NotificationBuffer` (interface) — per-actor historical buffer
  - `makeNotificationBuffer(client)` (internal constructor with Scope finalizer)
  - `ConversationActor.notifications` (field) — buffer attached to every actor returned by `acquireClient`

DELETED:

- `packages/protocol/src/testing/conformance/_shared/driver/test-client.ts`
  - `TestClient.notifications` (field)
  - `TestClient.waitForNotification` (method)
  - `TestClient.drainNotifications` (field)
  - `NotificationWaitError` (TaggedError)
  - `NotificationQueue` (type alias)
  - `runtime.notificationQueue` (Ref field)
  - `appendNotification`, `queueNotification`, `takeNotification`,
    `pollNotification`, `failIfClosedWhileWaiting`,
    `makeNotificationsStream`, `pullNotifications`, `socketClosedError`
    (internal helpers)
  - `DEFAULT_WAIT_FOR_NOTIFICATION_TIMEOUT_MS`, `POLL_INTERVAL_MS` (constants)
- `packages/protocol/src/testing/conformance/client/runner.ts`
  - `RealClientNotificationFilter` three-field record (replaced by predicate alias)
- `packages/server/src/test-utils/helpers.ts`
  - `NotificationBuffer` (type alias)
  - `pullOneMatching`, `makeSubscribeStream` (internal helpers)
  - `SUBSCRIBE_POLL_INTERVAL_MS` (constant)
  - `ServerTestClient.notifications`, `ServerTestClient.drainNotifications`
    (passthrough fields)
- `packages/client/src/test-utils/conformance-adapter.ts`
  - `notificationMatchesFilter`, `refinementFromRealClientFilter`,
    `asNotificationParamsRecord`, `tagMatches`, `conversationMatches`
    (5 helpers)

CHANGED:

- `packages/protocol/src/testing/conformance/_shared/driver/test-client.ts`
  - `TestClient.subscribe<D>(def, refinement?)` added (overload + type-guard)
  - `TestClient.subscribeAll(refinement?)` added
  - `TestClientRuntime.subscribers: TestSubscriberRegistry` added
  - `handleNotificationFrame` calls `registry.dispatch(notification)`
- `packages/protocol/src/testing/conformance/client/runner.ts`
  - `RealClientNotificationFilter` type alias (predicate)
  - `RealClientNotificationSubscriber.subscribe(filter?)` (predicate optional)
- `packages/protocol/src/testing/conformance/{task,network,app}/_helpers.ts`,
  `_driver.ts`, `task-close-lifecycle.ts` (6 call sites migrate to
  `subscribe` / `subscribeAll`)
- `packages/server/src/test-utils/helpers.ts`
  - `ServerTestClient.subscribeTo<D>(def)` => one-line passthrough to
    `testClient.subscribe(def)`
- `packages/server/src/__tests__/integration/**` (6 sites): `drainNotifications`
  callers migrate to `subscribe(def).pipe(Stream.runCollect)` or
  `subscribeAll().pipe(Stream.runCollect)`
- `packages/client/src/test-utils/conformance-adapter.ts`
  - `subscribeRealClient` accepts `filter` predicate directly; passes
    through to `MoltZapAgentClient.subscribeAll(filter)`
