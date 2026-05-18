# Inbound Dispatch Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Full path from raw wire bytes to `InboundHandler` invocation, including the
lease admission state machine and the ack/release race buffer.

```text
  server        WS reader fiber     MoltZapWsClient     MoltZapChannelCore   InboundHandler
    │                  │                   │                    │                   │
    │──JSON-RPC ──────▶│                   │                    │                   │
    │  notification    │                   │                    │                   │
    │  "dispatch/      │                   │                    │                   │
    │   release"       │ handleIncoming()  │                    │                   │
    │  OR              │  decodeFrames()   │                    │                   │
    │  messages/       │  (frame.ts → decodeFrame)              │                   │
    │  received        │   JSON.parse(raw) │                    │                   │
    │   notification   │   decodeServer-   │                    │                   │
    │                  │   Inbound()       │                    │                   │
    │                  │  (ws-client.ts → handleIncoming)       │                   │
    │                  │                   │                    │                   │
    │ [notification frame route]           │                    │                   │
    │                  │ handleDecoded-    │                    │                   │
    │                  │  Notification()   │                    │                   │
    │                  │  (ws-client.ts → handleDecodedNotification):              │
    │                  │  subscribers.     │                    │                   │
    │                  │   dispatch(frame) │                    │                   │
    │                  │   (subscribers.ts → SubscriberRegistry.dispatch)          │
    │                  │   snapshot subs   │                    │                   │
    │                  │   filter-match    │                    │                   │
    │                  │   each sub calls  │                    │                   │
    │                  │    handler(frame) │                    │                   │
    │                  │                  ──────────────────────▶ [MoltZapService.  │
    │                  │                   │                    │  handleNotifi-    │
    │                  │                   │                    │  cation()]        │
    │                  │                   │                    │                   │
    │ [messages/received notification]     │                    │                   │
    │                  │                   │      service.handleMessageReceived-    │
    │                  │                   │      Notification() (service.ts →      │
    │                  │                   │      handleMessageReceivedNotification):
    │                  │                   │      recordMessageIdIfNew → dedup     │
    │                  │                   │      storeMessage → messagesRef       │
    │                  │                   │      fanout(handlers.message, msg)    │
    │                  │                   │                    │                   │
    │                  │                   │      channel-core "message" listener   │
    │                  │                   │      (channel-core.ts → message listener):
    │                  │                   │      closedConversation? → drop        │
    │                  │                   │      Queue.unsafeOffer(inboundQueue,   │
    │                  │                   │        {message, attempt:0, clock})    │
    │                  │                   │                    │                   │
    │                  │                   │      [consumer fiber loops on queue]   │
    │                  │                   │      Queue.take(inboundQueue)          │
    │                  │                   │      (channel-core.ts → consumer fiber loop)
    │                  │                   │      takeDispatchCandidate():          │
    │                  │                   │        if parked[convId] → dequeue     │
    │                  │                   │        oldest instead                  │
    │                  │                   │                    │                   │
    │ [admission: dispatch/request round-trip]                  │                   │
    │                  │                   │      dispatchAdmission(work):          │
    │                  │                   │      (channel-core.ts → dispatchAdmission)
    │                  │                   │      service.requestDispatch({...})    │
    │                  │                   │◀─────────────────────────────────────  │
    │◀─────────────────────────────────── JSON-RPC "dispatch/request"               │
    │                  │                   │ ──────────────────▶ {leaseId,          │
    │                  │                   │                     dispatchId}        │
    │                  │                   │                    │                   │
    │ [release arrives — two races: ack-first vs release-first] │                   │
    │                  │                   │                    │                   │
    │ Case A: release arrives BEFORE ack returns:               │                   │
    │ ──dispatch/release notification ────▶│                    │                   │
    │                  │ subscribers.dispatch() → service        │                   │
    │                  │  → fanout(handlers.dispatchRelease)     │                   │
    │                  │  → channel-core recordDispatchRelease() │                   │
    │                  │  (channel-core.ts → recordDispatchRelease):                │
    │                  │  pendingDispatchesByLease.get(leaseId)  │                   │
    │                  │   = None → insert into                  │                   │
    │                  │     pendingReleasesByLease ring (cap 256│                   │
    │                  │     soft-TTL 30s)                       │                   │
    │                  │                   │                    │                   │
    │  ack returns → leaseId from server   │                    │                   │
    │                  │                   │ awaitDispatchRelease(leaseId):         │
    │                  │                   │ consumeDispatchRelease(leaseId)        │
    │                  │                   │   hit! → projectVerdict()             │
    │                  │                   │   (channel-core.ts → consumeDispatchRelease)
    │                  │                   │                    │                   │
    │ Case B: ack returns BEFORE release:  │                    │                   │
    │                  │                   │ awaitDispatchRelease(leaseId):         │
    │                  │                   │ Deferred.make() →                      │
    │                  │                   │ pendingDispatchesByLease.set(leaseId,  │
    │                  │                   │   deferred)        │                   │
    │                  │                   │ Deferred.await(deferred)               │
    │                  │                   │   (timeout = admissionTimeoutMs 30s)   │
    │ ──dispatch/release notification ────▶│                    │                   │
    │                  │  recordDispatchRelease():              │                   │
    │                  │  pendingDispatchesByLease.get(leaseId) │                   │
    │                  │   = Some(deferred) → Deferred.succeed()│                   │
    │                  │   (channel-core.ts → recordDispatchRelease, deferred path) │
    │                  │                   │ ◀── settled ───────│                   │
    │                  │                   │ projectVerdict()   │                   │
    │                  │                   │                    │                   │
    │ [verdict routing]│                   │                    │                   │
    │                  │                   │  decision._tag:    │                   │
    │                  │                   │  "deny"  → log + drop                 │
    │                  │                   │  "hold"  → parkDispatchWork()          │
    │                  │                   │            (re-queues front of parked) │
    │                  │                   │  "grant" → dispatchGrantedWork()       │
    │                  │                   │   (channel-core.ts → dispatchGrantedWork)
    │                  │                   │                    │                   │
    │ [grant: enrich + invoke handler]     │                    │                   │
    │                  │                   │ takeCoalescedConversationMessages()    │
    │                  │                   │  drains same-conv msgs from queue +    │
    │                  │                   │  parked (channel-core.ts →             │
    │                  │                   │  takeCoalescedConversationMessages)    │
    │                  │                   │ dispatchWithLease():                   │
    │                  │                   │  leaseIdInFlight = leaseId             │
    │                  │                   │  dispatchInboundEffect(messages):      │
    │                  │                   │   enrichMessage() → resolveAgentName,  │
    │                  │                   │    getConversation, peekContextEntries │
    │                  │                   │   (channel-core-enrichment.ts →        │
    │                  │                   │    enrichMessage)                      │
    │                  │                   │   inboundHandler(enriched) ───────────▶│
    │                  │                   │                    │ ◀── Effect.void ──│
    │                  │                   │   leaseIdInFlight = previous           │
    │                  │                   │   (channel-core.ts → dispatchWithLease)│
    │                  │                   │                    │                   │
    │                  │                   │   lease timeout gate (default 90s):    │
    │                  │                   │   if handler takes > leaseTimeoutMs    │
    │                  │                   │   → DispatchLeaseExpired logged        │
    │                  │                   │   (channel-core.ts → dispatchWithLease, timeout branch)
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
