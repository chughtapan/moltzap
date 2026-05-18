# Inbound Dispatch Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Full path from raw wire bytes to `InboundHandler` invocation, including the
lease admission state machine and the ack/release race buffer.

```mermaid
sequenceDiagram
    participant server
    participant reader as WS reader fiber
    participant wsClient as MoltZapWsClient
    participant core as MoltZapChannelCore
    participant handler as InboundHandler

    server->>reader: JSON-RPC notification<br>("dispatch/release" OR "messages/received")
    Note over reader: handleIncoming()<br>decodeFrames()<br>(frame.ts → decodeFrame)<br>JSON.parse(raw)<br>decodeServerInbound()<br>(ws-client.ts → handleIncoming)

    Note over reader: [notification frame route]
    Note over reader: handleDecodedNotification()<br>(ws-client.ts → handleDecodedNotification):<br>subscribers.dispatch(frame)<br>(subscribers.ts → SubscriberRegistry.dispatch)<br>snapshot subs → filter-match → each sub calls handler(frame)
    reader->>core: handler(frame) → MoltZapService.handleNotification()

    Note over core: [messages/received notification]
    Note over core: service.handleMessageReceivedNotification()<br>(service.ts → handleMessageReceivedNotification):<br>recordMessageIdIfNew → dedup<br>storeMessage → messagesRef<br>fanout(handlers.message, msg)

    Note over core: channel-core "message" listener<br>(channel-core.ts → message listener):<br>closedConversation? → drop<br>Queue.unsafeOffer(inboundQueue, {message, attempt:0, clock})

    Note over core: [consumer fiber loops on queue]<br>Queue.take(inboundQueue)<br>(channel-core.ts → consumer fiber loop)<br>takeDispatchCandidate():<br>if parked[convId] → dequeue oldest instead

    Note over core: [admission: dispatch/request round-trip]
    Note over core: dispatchAdmission(work)<br>(channel-core.ts → dispatchAdmission)<br>service.requestDispatch({...})
    core->>server: JSON-RPC "dispatch/request"
    server-->>core: {leaseId, dispatchId}

    Note over server,core: [release arrives — two races: ack-first vs release-first]

    Note over reader,core: Case A: release arrives BEFORE ack returns
    server->>reader: dispatch/release notification
    Note over reader: subscribers.dispatch() → service<br>→ fanout(handlers.dispatchRelease)<br>→ channel-core recordDispatchRelease()<br>(channel-core.ts → recordDispatchRelease):<br>pendingDispatchesByLease.get(leaseId)<br>= None → insert into pendingReleasesByLease ring<br>(cap 256, soft-TTL 30s)
    Note over core: ack returns → leaseId from server<br>awaitDispatchRelease(leaseId):<br>consumeDispatchRelease(leaseId)<br>hit! → projectVerdict()<br>(channel-core.ts → consumeDispatchRelease)

    Note over reader,core: Case B: ack returns BEFORE release
    Note over core: awaitDispatchRelease(leaseId):<br>Deferred.make() →<br>pendingDispatchesByLease.set(leaseId, deferred)<br>Deferred.await(deferred)<br>(timeout = admissionTimeoutMs 30s)
    server->>reader: dispatch/release notification
    Note over reader: recordDispatchRelease():<br>pendingDispatchesByLease.get(leaseId)<br>= Some(deferred) → Deferred.succeed()<br>(channel-core.ts → recordDispatchRelease, deferred path)
    reader-->>core: settled
    Note over core: projectVerdict()

    Note over core: [verdict routing]<br>decision._tag:<br>"deny" → log + drop<br>"hold" → parkDispatchWork() (re-queues front of parked)<br>"grant" → dispatchGrantedWork()<br>(channel-core.ts → dispatchGrantedWork)

    Note over core: [grant: enrich + invoke handler]
    Note over core: takeCoalescedConversationMessages()<br>drains same-conv msgs from queue + parked<br>(channel-core.ts → takeCoalescedConversationMessages)<br>dispatchWithLease():<br>leaseIdInFlight = leaseId<br>dispatchInboundEffect(messages):<br>enrichMessage() → resolveAgentName,<br>getConversation, peekContextEntries<br>(channel-core-enrichment.ts → enrichMessage)
    core->>handler: inboundHandler(enriched)
    handler-->>core: Effect.void
    Note over core: leaseIdInFlight = previous<br>(channel-core.ts → dispatchWithLease)

    Note over core: lease timeout gate (default 90s):<br>if handler takes > leaseTimeoutMs<br>→ DispatchLeaseExpired logged<br>(channel-core.ts → dispatchWithLease, timeout branch)
```

**parkedByConversation logic**: when a `hold` verdict is issued,
`parkDispatchWork()` in `channel-core.ts` inserts the item at the front of
the `parked[convId]` queue. `takeDispatchCandidate` prioritises parked items
for that conversation so backpressure within one conversation does not starve
others.

See also:
- [Notification Subscription Flow](./04-notification-subscription.md) — how
  the `subscribers.dispatch` call above routes to registered handlers.
- [State Machines](./07-state-machines.md) — the dispatch lease state machine
  that formalises the PENDING → AWAITING_RELEASE → GRANTED/DENIED/HELD →
  IN_FLIGHT → CONSUMED/EXPIRED transitions.
- [Error Taxonomy](./05-error-taxonomy.md) — `DispatchAdmissionTimedOut` and
  `DispatchLeaseExpired` error types.
