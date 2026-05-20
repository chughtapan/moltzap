# State Machines

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Dispatch Lease State Machine

One lease per `dispatch/request` call. Managed jointly by server
(LeaseRegistry) and `MoltZapChannelCore` on the client side.

```mermaid
stateDiagram-v2
    [*] --> PENDING

    PENDING : PENDING[br]dispatch/request sent[br](channel-core.ts → dispatchAdmission)[br]server minting lease

    PENDING --> AWAITING_RELEASE : dispatch/request ack returns {leaseId}

    AWAITING_RELEASE : AWAITING_RELEASE[br]Deferred registered (or ring-buffered entry consumed)[br](channel-core.ts → awaitDispatchRelease)

    AWAITING_RELEASE --> GRANTED : dispatch/release arrives[br]verdict.decision = "grant"
    AWAITING_RELEASE --> DENIED : dispatch/release arrives[br]verdict.decision = "deny"
    AWAITING_RELEASE --> HELD : dispatch/release arrives[br]verdict.decision = "hold"

    GRANTED : GRANTED[br]proceed to enrichment
    DENIED : DENIED[br]drop message, log,[br]consumer fiber continues
    HELD : HELD[br]parkDispatchWork(),[br]re-queued at front of parked[convId]

    GRANTED --> IN_FLIGHT : dispatchGrantedWork()

    IN_FLIGHT : IN_FLIGHT[br]leaseIdInFlight = leaseId[br](channel-core.ts → dispatchWithLease)[br]InboundHandler executing[br](lease authorizes one messages/send call)

    IN_FLIGHT --> CONSUMED : handler completes within leaseTimeoutMs (90s default)[br]server marks via dispatchLeaseId in messages/send params
    IN_FLIGHT --> EXPIRED : handler exceeds leaseTimeoutMs[br]DispatchLeaseExpired logged,[br]server-side lease times out independently

    CONSUMED --> [*]
    DENIED --> [*]
    EXPIRED --> [*]
```

**Annotations:**
- `HELD` re-enters the queue: `takeDispatchCandidate` prioritises the `parked[convId]` front so the same conversation gets another dispatch attempt without starving other conversations.

See also: [Inbound Dispatch Sequence](./inbound-dispatch.md) for the full
sequence that drives these state transitions, including the ack/release race
(Cases A and B).

## Connection State Machine

`MoltZapWsClient` transitions, driven by `stateRef` and the `closed` flag.

```mermaid
stateDiagram-v2
    [*] --> INIT

    INIT : INIT[br]stateRef = None[br]closed = false

    INIT --> CONNECTING : connect() called

    CONNECTING : CONNECTING[br]openSocket() (10s timeout)[br]startTaskCallbackDispatcher()[br]readerFiber forked[br]sendRpc(Connect) in flight

    CONNECTING --> CONNECTED : HelloOk received[br]stateRef = Some(ConnState)

    CONNECTED : CONNECTED[br]stateRef = Some(ConnState)[br]_helloOk set[br]closed = false

    CONNECTED --> DISCONNECTED : reader fiber exits (network error / server close)[br]_helloOk = null[br]failAllPending()[br]stateRef = None[br]onDisconnect(closeInfo) called

    DISCONNECTED : DISCONNECTED[br]stateRef = None[br]closed = false (reconnectable)

    DISCONNECTED --> CONNECTING : scheduleReconnect() fires[br]exponential backoff (1s–30s, jitter)[br]Effect.retry(Schedule) — TestClock-compatible[br]connectEffect() succeeds → onReconnect(helloOk) called

    INIT --> CLOSED : close() called
    CONNECTING --> CLOSED : close() called
    CONNECTED --> CLOSED : close() called
    DISCONNECTED --> CLOSED : close() called

    CLOSED : CLOSED (terminal)[br]closed = true[br]stateRef = None[br]reconnectFiber = null[br]No further reconnects
    CLOSED --> [*]
```

**Annotations:**
- `close()` actions (any state): `closed = true`, reconnectFiber interrupted, `failAllPending()`, `failAllNotificationWaiters()`, `subscribers.closeAll`, `write(CloseEvent(1000))` if handshake completed, `Scope.close(scope)`, `Scope.close(dispatcherScope)` [via runFork], `runtime.dispose()`.

See also: [Connection Lifecycle](./connection-lifecycle.md) for the
bootstrap sequence and reconnect arm that drive these transitions.
