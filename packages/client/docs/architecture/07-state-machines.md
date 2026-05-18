# State Machines

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Dispatch Lease State Machine

One lease per `dispatch/request` call. Managed jointly by server
(LeaseRegistry) and `MoltZapChannelCore` on the client side.

```text
         ┌──────────────────────────────────────────┐
         │            PENDING                       │
         │  dispatch/request sent                   │
         │  (channel-core.ts → dispatchAdmission);  │
         │  server minting lease                    │
         └──────────┬───────────────────────────────┘
                    │
          dispatch/request ack returns {leaseId}
                    │
         ┌──────────▼───────────────────────────────┐
         │       AWAITING_RELEASE                   │
         │  Deferred registered (or ring-buffered   │
         │  entry consumed)                         │
         │  (channel-core.ts → awaitDispatchRelease)│
         └──────────┬───────────────────────────────┘
                    │ dispatch/release notification arrives
                    │ verdict.decision:
          ┌─────────┼─────────────────────────┐
          ▼         ▼                         ▼
       GRANTED    DENIED                    HELD
  (proceed to    (drop message;          (parkDispatch-
   enrichment)    log; consumer           Work(); re-
                  fiber continues)        queued at
                                          front of
                                          parked[convId])
          │
          ▼
      IN_FLIGHT
  leaseIdInFlight = leaseId
  (channel-core.ts → dispatchWithLease)
  InboundHandler executing
  (lease authorizes one
   messages/send call)
          │
          ├─── handler completes within leaseTimeoutMs (90s default)
          │         ▼
          │     CONSUMED
          │    (server marks via dispatchLeaseId
          │     in messages/send params)
          │
          └─── handler exceeds leaseTimeoutMs
                    ▼
               EXPIRED (client side)
               DispatchLeaseExpired logged;
               server-side lease times out
               independently
```

See also: [Inbound Dispatch Sequence](./03-inbound-dispatch.md) for the full
sequence that drives these state transitions, including the ack/release race
(Cases A and B).

## Connection State Machine

`MoltZapWsClient` transitions, driven by `stateRef` and the `closed` flag.

```text
         ┌──────────────────────────────────┐
         │         INIT                     │
         │  stateRef = None                 │
         │  closed = false                  │
         └──────────┬───────────────────────┘
                    │ connect() called
                    │
         ┌──────────▼───────────────────────┐
         │      CONNECTING                  │
         │  openSocket() (10s timeout)      │
         │  startTaskCallbackDispatcher()   │
         │  readerFiber forked              │
         │  sendRpc(Connect) in flight      │
         └──────┬───────────────────────────┘
                │ HelloOk received
                │ stateRef = Some(ConnState)
                ▼
         ┌──────────────────────────────────┐
         │       CONNECTED                  │
         │  stateRef = Some(ConnState)      │
         │  _helloOk set                    │
         │  closed = false                  │
         └──────┬───────────────────────────┘
                │ reader fiber exits (network error,
                │ server close, etc.)
                │ _helloOk = null
                │ failAllPending()
                │ stateRef = None
                │ onDisconnect(closeInfo) called
                ▼
         ┌──────────────────────────────────┐
         │     DISCONNECTED                 │
         │  stateRef = None                 │
         │  closed = false (reconnectable)  │
         └──────┬───────────────────────────┘
                │ scheduleReconnect() fires:
                │   exponential backoff (1s–30s, jitter)
                │   loops via Effect.retry(Schedule)
                │   TestClock-compatible
                ╔══════════════════════╗
                ║   [reconnect loop]   ║
                ╚═════════════════════╝
                │ connectEffect() succeeds
                │ onReconnect(helloOk) called
                └──────────────▶ CONNECTED

         close() called at any state:
                │ closed = true
                │ reconnectFiber interrupted
                │ failAllPending()
                │ failAllNotificationWaiters()
                │ subscribers.closeAll
                │ write(CloseEvent(1000)) if handshake completed
                │ Scope.close(scope)
                │ Scope.close(dispatcherScope) [via runFork]
                │ runtime.dispose()
                ▼
         ┌──────────────────────────────────┐
         │         CLOSED (terminal)        │
         │  closed = true                   │
         │  stateRef = None                 │
         │  reconnectFiber = null           │
         │  No further reconnects           │
         └──────────────────────────────────┘
```

See also: [Connection Lifecycle](./01-connection-lifecycle.md) for the
bootstrap sequence and reconnect arm that drive these transitions.
