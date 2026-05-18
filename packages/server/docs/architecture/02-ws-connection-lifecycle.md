# WebSocket Connection Lifecycle (per-connection Scope)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The `/ws` route upgrades the HTTP request to a Socket, then hands it to
`handleSocket` which builds a single Scoped Effect for the connection's
entire lifetime:

```text
GET /ws (Upgrade: websocket)
   │
   ▼ wsRoute: req.upgrade → socket: Socket.Socket           app/server.ts → wsRoute
   │
   ▼ handleSocket(socket) — Effect.scoped wrapper           app/server.ts → handleSocket
   │
   │  connId = crypto.randomUUID()
   │  writer = yield* socket.writer
   │  closeRequested = yield* Deferred.make<void>()
   │
   │  ┌─ acquireConnectionRpcClient(connId, write)         transport/connection.ts
   │  │     makeJsonRpcClient({write, idPrefix})            ── server→client callbacks
   │  │     scope-bound: finalizer fails every pending Deferred with NotConnectedError
   │  │
   │  ▼
   │  connections.add({
   │    id, write, shutdown: Deferred.succeed(closeRequested),
   │    auth: null, lastPong: Date.now(),
   │    conversationIds: new Set(), mutedConversations: new Set(),
   │    jsonRpcClient,
   │  })                                                    app/server.ts → handleSocket (connections.add)
   │
   ▼  reader = socket.runRaw(data => handleFrame(decode(data)))
   │
   ▼  Effect.raceFirst(reader, Deferred.await(closeRequested))
   │       ↑
   │       │ ── raceFirst (not race): an abnormal close that completes the
   │       │     reader fiber before anyone calls shutdown still triggers
   │       │     onExit. With plain `race`, abrupt disconnects leak.
   │       │
   ▼  Effect.onExit(exit => /* cleanup */)
        │
        ├─ if (authCtx) presenceService.setOffline(agentId)
        │
        ├─ for hook of disconnectionHooks:
        │     runUserHook(hook, {agentId, ownerUserId, connId},
        │                  "Disconnection hook", logContext)
        │     # SEQUENTIAL (not parallel) — earlier hook's cleanup
        │     # (e.g. last_seen_at write) completes before next hook
        │     # observes post-close state.
        │
        ├─ if (authCtx)
        │     agentEndpointResolver.remove(agentId, connId)
        │     # Slice G1 plan §2.11 — drops the multimap entry
        │
        ├─ leaseRegistry.abandon(connId)                    app/server.ts → handleSocket (disconnect finalizer)
        │     # #529 reshape: drain leases bound to this connection
        │     #   PENDING → ABANDONED
        │     #   GRANTED/HOLD → EXPIRED-on-disconnect
        │     #   CLAIMED → no-op (load-bearing: in-flight messages/send
        │     #                     owns the lease via acquireUseRelease)
        │
        ├─ presenceService.removeConnection(connId)
        ├─ connections.remove(connId)
        │
        └─ logInfo("WebSocket disconnected", {connId})
```

## See also

- [§03 Request → response handling](./03-request-response-handling.md)
- [§06 Lease lifecycle](./06-lease-lifecycle.md) — `leaseRegistry.abandon` detail
- [§09 Shutdown sequence](./09-shutdown-sequence.md) — `conn.shutdown` signal
