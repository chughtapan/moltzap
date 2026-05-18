# Notification Subscription Flow

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

> **Status — Spec B (#596) impl-staff scope:** This doc is an architect
> outline. Impl-staff fills the diagram + prose per the H2 outline below
> and the dataflow contract pins from architect plan #604 §6.

## Overview

`MoltZapWsClient` exposes two notification consumption entry points, both
returning `Stream.Stream` values:

- `subscribe<D>(def, refinement?)` — typed Stream over one definition's
  decoded notifications. The standard consumer surface.
- `subscribeAll(refinement?)` — broad-union Stream over every inbound
  notification. Used only by `MoltZapService.connect`'s internal
  notification fanout (the one infrastructure-glue case).

Both Streams are **lazy** — constructing them is pure; subscription
registration happens on `Stream.run*` (materialization) via
`Effect.acquireRelease(register, unregister)`. This is the AD1 path-(a)
contract documented in architect plan #604 §3.

## Stream lifecycle contract

Six rows, verbatim from spec #596 §"Stream lifecycle contract":

| Stage | Behavior |
|---|---|
| **Subscription construction** | NEVER fails. Pure value. Legal pre-`connect()`. |
| **Stream materialization** | NEVER fails. `acquireRelease(register, unregister)` runs; in-memory only. |
| **First pull before connect** | **Suspends** in the per-sub queue's `Queue.take`. No `NotConnectedError`. |
| **Mid-stream disconnect** | Stream does not terminate during transient disconnects (reconnect-survival preserved). |
| **Closed client** | Terminates with `NotConnectedError` in the error channel. |
| **Reconnect** | Subscription persists; consumer's `runForEach` resumes pulling from the same queue. |

## Dataflow diagram

> **Impl-staff:** replace this section with a Mermaid sequenceDiagram. The
> shape is pinned by architect plan #604 §6 — copy that diagram verbatim
> as a starting point. Validate Mermaid syntax per `CLAUDE.md` §"Mermaid
> diagrams" gotchas before committing.

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

1. Consumer cancels Stream (typically `Stream.runForEach`'s scope ends).
2. `Effect.acquireRelease`'s finalizer fires: `unregister`.
3. `unregister` does `Ref.update(subsRef, drop X)` then
   `Queue.shutdown(X.queue)`.
4. Dispatch's next `Ref.get(subsRef)` snapshot excludes X.
5. Frames in X's queue at the moment of shutdown are discarded.

The snapshot semantic from spec #222 §5.3 OQ-3 holds at the **registry's
dispatch iteration** level: dispatch never re-reads `subsRef` mid-loop, so
in-flight dispatch of frame N is not interrupted by unsubscribe during
frame N.

## Migration recipe (from deleted `waitForNotification`)

```ts
client.subscribe(def).pipe(
  Stream.runHead,
  Effect.timeoutFail({
    duration: "5 seconds",
    onTimeout: () => new TimeoutError({ definition: def.name, durationMs: 5000 }),
  }),
  Effect.flatMap(Option.match({
    onNone: () => Effect.fail(new StreamClosedError({ definition: def.name })),
    onSome: Effect.succeed,
  })),
)
```

Tagged errors live at `packages/client/src/notification/errors.ts`:
`NotificationConsumerError` (base), `TimeoutError`, `StreamClosedError`.

## See also

- [Inbound Dispatch Sequence](./03-inbound-dispatch.md) — reader fiber →
  `SubscriberRegistry.dispatch`.
- [Error Taxonomy](./05-error-taxonomy.md) — `NotConnectedError` (terminal)
  + the three new notification-consumer tagged errors.
- Architect plan: [#604](https://github.com/chughtapan/moltzap/issues/604).
- Spec: [#596](https://github.com/chughtapan/moltzap/issues/596).
