# Notification Subscription Flow

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```mermaid
sequenceDiagram
    participant caller
    participant wsClient as MoltZapWsClient
    participant registry as SubscriberRegistry
    participant server

    caller->>wsClient: client.subscribe(filter, handler)<br/>(ws-client.ts → MoltZapWsClient.subscribe)
    Note over wsClient: closed? → fail(NotConnectedError)
    wsClient->>registry: subscribers.register(filter, handler)
    Note over registry: nextSubscriptionId()<br/>Ref.update(subsRef, append LiveSubscription)<br/>(subscribers.ts → SubscriberRegistry.register)
    registry-->>wsClient: NotificationSubscription {id, unsubscribe}
    wsClient-->>caller: NotificationSubscription {id, unsubscribe}<br/>(handle held by caller for lifetime)

    Note over caller,server: [notification arrives from server]
    server->>wsClient: frame (any method)
    Note over wsClient: handleDecodedNotification()<br/>subscribers.dispatch(frame)
    wsClient->>registry: subscribers.dispatch(frame)
    Note over registry: snapshot = Ref.get(subsRef)<br/>for sub of snapshot:<br/>  matchesFilter(sub.filter, frame)?<br/>    emissionTag exact match<br/>    conversationId exact match<br/>    notificationNamePrefix startsWith<br/>    (subscribers.ts → matchesFilter)<br/>  yes → sub.handler(frame)<br/>  (await Effect, catchAllDefect)<br/>  (subscribers.ts → SubscriberRegistry.dispatch)

    Note over wsClient: takeNotificationWaiter(frame):<br/>waitersMap bucket pop<br/>waiter present → Deferred.succeed()<br/>no waiter → bufferNotification()<br/>(ws-client.ts → takeNotificationWaiter)

    Note over caller,server: [caller unsubscribes]
    caller->>wsClient: handle.unsubscribe (Effect&lt;void,never&gt;)
    wsClient->>registry: unsubscribe(id)
    Note over registry: Ref.update(subsRef, filter out id)<br/>(subscribers.ts → SubscriberRegistry.unsubscribe)<br/>next frame sees updated snapshot
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
