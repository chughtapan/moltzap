# Notification Subscription Flow

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Overview

`MoltZapWsClient` exposes two notification consumption entry points, both
returning `Stream.Stream` values:

- `subscribe<D>(def, refinement?)` — typed Stream over one definition's
  decoded notifications. The standard consumer surface. A user-defined
  type-guard overload narrows the Stream's payload to
  `DecodedNotification<D, R>` for sum-type definitions.
- `subscribeAll(refinement?)` — broad-union Stream over every inbound
  notification. Used only by `MoltZapService.connect`'s internal
  notification fanout (the one infrastructure-glue case).

Both Streams are **lazy** — constructing them is pure; subscription
registration happens at materialization time via `Stream.async`'s
register callback. This is the AD1 path-(a) contract documented in
architect plan #604 §3 and pinned at compile time by
`snapshot-semantics.types-check.ts → Canary #1` … `Canary #4`.

## Stream lifecycle contract

| Stage | Behavior |
|---|---|
| **Subscription construction** | Never fails. Pure value. Legal pre-`connect()`. |
| **Stream materialization** | Synchronous `registry.register(...)` call inside the `Stream.async` register callback. In-memory only. |
| **First pull before connect** | Suspends inside `Stream.async`'s internal buffer until `emit.single`/`emit.fail` fires. No `NotConnectedError` is raised on the consumer side until terminal close. |
| **Mid-stream disconnect** | Stream does not terminate during transient disconnects — `SubscriberRegistry` survives the reconnect path, and the reader fiber resumes feeding `onFrame` on the new socket. Frames lost at the transport during the disconnect window are pre-existing (spec #222). |
| **Closed client** | Terminates with `NotConnectedError` in the error channel via the registry's `closeAll` → each sub's `onClose(new NotConnectedError(...))` → Stream's `emit.fail` path. |
| **Reconnect** | Subscription persists; consumer's `runForEach` resumes consuming the same Stream. |

## Dataflow diagram

```mermaid
sequenceDiagram
    participant caller
    participant wsClient as MoltZapWsClient
    participant stream as notification/stream.ts
    participant registry as SubscriberRegistry
    participant reader as WS reader fiber
    participant server

    caller->>wsClient: client.subscribe(def, refinement?)
    Note over wsClient: pure: returns Stream value<br>(no I/O, no scope yet)
    wsClient->>stream: stream.subscribe(registry, def, refinement?)
    stream-->>wsClient: Stream<DecodedNotification<D>, NotConnectedError>
    wsClient-->>caller: Stream<...> (lazy)

    caller->>caller: stream.pipe(Stream.runForEach(...))
    Note over caller: materialization runs Stream.async's<br>register callback (synchronous)
    caller->>stream: emit installed; register(def, refinement, {onFrame, onClose})
    stream->>registry: register(def, refinement, callbacks)
    Note over registry: nextId<br>Ref.update(subsRef, append live)<br>return {unregister}
    registry-->>stream: {unregister}
    Note over stream: onFrame → emit.single<br>onClose → emit.fail<br>finalizer → handle.unregister

    Note over caller,server: [steady state]
    server->>reader: notification frame
    reader->>wsClient: handleIncoming → handleDecodedNotification
    wsClient->>registry: dispatch(decoded)
    Note over registry: snapshot = Ref.get(subsRef)<br>for sub of snapshot:<br>  matchesDefinition? matchesRefinement?<br>  yes → sub.onFrame(decoded)
    registry-->>caller: emit.single → runForEach handler fires

    Note over caller,server: [caller cancels Stream]
    caller->>caller: scope ends (Effect.interrupt, runHead settled)
    caller->>stream: Stream.async finalizer fires
    stream->>registry: handle.unregister
    Note over registry: Ref.update(subsRef, drop sub)

    Note over caller,server: [client.close — terminal]
    wsClient->>registry: subscribers.closeAll
    Note over registry: for each live sub: sub.onClose(new NotConnectedError(...))<br>Ref.set(subsRef, [])
    Note over caller: in-flight Streams terminate via emit.fail with<br>NotConnectedError in their error channel
```

## Filter / refinement semantics

- The `refinement` parameter is a TypeScript predicate over the
  definition's `params` shape. Compiler-verified field names; runtime
  filtering at dispatch-time inside `SubscriberRegistry.dispatch`.
- The user-defined-type-guard overload (`params is R`) narrows the
  Stream's payload to `DecodedNotification<D, R>` — useful when a single
  definition carries a sum type that downstream code needs split.
- Multi-definition fan-out is `Stream.mergeAll([subscribe(def1),
  subscribe(def2)])` — exhaustively typed by the discriminated union.

## Cancellation semantics (AD1 path-(a))

1. Consumer cancels Stream (typically `Stream.runForEach`'s scope ends,
   `Stream.runHead` resolves, or the parent fiber is interrupted).
2. `Stream.async`'s finalizer fires: `Effect.suspend(() => handle.unregister)`.
3. `unregister` does `Ref.update(subsRef, drop X)` atomically.
4. Dispatch's next `Ref.get(subsRef)` snapshot excludes X.

The snapshot semantic from spec #222 §5.3 OQ-3 holds at the **registry's
dispatch iteration** level: dispatch never re-reads `subsRef` mid-loop, so
in-flight dispatch of frame N is not interrupted by unsubscribe during
frame N. The runtime property tests in
`packages/client/src/notification/__tests__/snapshot-semantics.test.ts`
exercise this invariant end-to-end.

## Migration recipe (from deleted `waitForNotification`)

```ts
client.subscribe(def).pipe(
  Stream.runHead,
  Effect.timeoutFail({
    duration: Duration.seconds(5),
    onTimeout: () =>
      new NotificationTimeoutError({ definition: def.name, durationMs: 5000 }),
  }),
  Effect.flatMap(
    Option.match({
      onNone: () =>
        Effect.fail(new NotificationStreamClosedError({ definition: def.name })),
      onSome: Effect.succeed,
    }),
  ),
);
```

For tests using `@moltzap/server-core/test-utils`, the
`awaitOneNotification(client, def, timeoutMs?)` helper wraps the recipe
above. For tests using the protocol-side `TestClient`, the
`TestClient.waitForNotification` API is preserved (spec #596 Non-goals
row 2) and remains the ergonomic test-side API.

Tagged errors live at `packages/client/src/notification/errors.ts`:
`NotificationConsumerError` (the union), plus `TimeoutError` and
`StreamClosedError`.

## Subscribe-before-trigger pattern

When a test or call site needs to observe a notification that follows a
specific request, the Stream subscription **must be materialised before**
the trigger RPC is issued — otherwise the response notification can
arrive between the trigger and the consumer's first pull. The canonical
shape is:

```ts
const fiber = yield* Effect.fork(
  client.subscribe(def).pipe(Stream.runHead, /* timeout */),
);
yield* client.sendRpc(triggerDef, params); // the action that emits `def`
const result = yield* Fiber.join(fiber);
```

`packages/runtimes/src/trace-capture-harness.ts → sendMessageAndWait`
demonstrates this pattern; the dispatch-flow fixture and
`@moltzap/server-core/test-utils → awaitOneNotification` follow the same
shape via the `client.notifications` Stream's internal buffer (the
`TestClient.notifications` Stream buffers across the trigger window so
test sites can keep the simpler post-trigger form).

## See also

- [Inbound Dispatch Sequence](./03-inbound-dispatch.md) — reader fiber →
  `SubscriberRegistry.dispatch`.
- [Error Taxonomy](./05-error-taxonomy.md) — `NotConnectedError` (terminal)
  + the three new notification-consumer tagged errors.
- Architect plan: [#604](https://github.com/chughtapan/moltzap/issues/604).
- Spec: [#596](https://github.com/chughtapan/moltzap/issues/596).
