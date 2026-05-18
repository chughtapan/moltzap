# Notification Subscription Flow

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```text
  caller             MoltZapWsClient        SubscriberRegistry    server
    │                      │                       │                 │
    │──client.subscribe(───▶│                       │                 │
    │   filter, handler)    │                       │                 │
    │  (ws-client.ts → MoltZapWsClient.subscribe)  │                 │
    │                       │ closed? → fail(NotConnectedError)       │
    │                       │ subscribers.register(filter, handler)   │
    │                       │──────────────────────▶│                 │
    │                       │                       │ nextSubscriptionId()
    │                       │                       │ Ref.update(subsRef,
    │                       │                       │   append LiveSubscription)
    │                       │                       │ (subscribers.ts → SubscriberRegistry.register)
    │ ◀── NotificationSubscription {id, unsubscribe} │                 │
    │   (handle held by caller for lifetime)         │                 │
    │                       │                       │                 │
    │   [notification arrives from server]           │                 │
    │                       │ ◀─ frame (any method) ──────────────────│
    │                       │ handleDecodedNotification():            │
    │                       │ subscribers.dispatch(frame)             │
    │                       │──────────────────────▶│                 │
    │                       │                       │ snapshot = Ref.get(subsRef)
    │                       │                       │ for sub of snapshot:
    │                       │                       │   matchesFilter(sub.filter, frame)?
    │                       │                       │    emissionTag exact match
    │                       │                       │    conversationId exact match
    │                       │                       │    notificationNamePrefix startsWith
    │                       │                       │    (subscribers.ts → matchesFilter)
    │                       │                       │   yes → sub.handler(frame)
    │                       │                       │   (await Effect, catchAllDefect)
    │                       │                       │   (subscribers.ts → SubscriberRegistry.dispatch)
    │                       │                       │                 │
    │                       │ takeNotificationWaiter(frame):          │
    │                       │  waitersMap bucket pop                  │
    │                       │  waiter present → Deferred.succeed()    │
    │                       │  no waiter → bufferNotification()       │
    │                       │  (ws-client.ts → takeNotificationWaiter)│
    │                       │                       │                 │
    │   [caller unsubscribes]│                      │                 │
    │──handle.unsubscribe───▶│                       │                 │
    │  (Effect<void,never>)  │                       │                 │
    │                       │                       │ Ref.update(subsRef,
    │                       │                       │   filter out id)
    │                       │                       │ (subscribers.ts → SubscriberRegistry.unsubscribe)
    │                       │                       │ next frame sees updated snapshot
```

**Filter semantics** (in `subscribers.ts → matchesFilter`): all three fields
are optional wildcards. `{}` matches every notification — used by
`MoltZapService.connect` (in `service.ts`) to hook all inbound notifications
for its internal handlers before calling `connect()`.
`notificationNamePrefix` uses `String.startsWith`; `emissionTag` and
`conversationId` use strict `===` against `frame.params.__emissionTag` and
`frame.params.conversationId` respectively.

**Unsubscribe semantics** (OQ-3 A): `unsubscribe` mutates `subsRef`
immediately. In-flight `dispatch` walks a snapshot captured at dispatch
start, so the unsubscribed handler may still fire for the current frame but
will not fire for frame N+1.

**`waitForNotification` vs `subscribe`**: `waitForNotification`
(in `ws-client.ts → waitForNotification`) is a one-shot awaiter used in
tests. It checks the notification buffer first; if empty it parks a
`Deferred` in `notificationWaitersRef`. Subscriber registry and one-shot
waiters are parallel paths — a notification satisfies both if both are
registered.

See also: [Inbound Dispatch Sequence](./03-inbound-dispatch.md) for how
`subscribers.dispatch` is called from the reader fiber.
