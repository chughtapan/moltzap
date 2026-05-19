# WebSocket Connection Lifecycle (per-connection Scope)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The `/ws` route (in `app/http-routes.ts → makeWsRoute`) upgrades the HTTP
request to a Socket, then hands it to `handleSocket` (constructed by
`app/socket-handler.ts → makeSocketHandler`, wired in `app/server.ts:100`).
`handleSocket` builds a single Scoped Effect for the connection's entire
lifetime:

```mermaid
sequenceDiagram
    participant C as Client
    participant WS as wsRoute
    participant HS as handleSocket
    participant RPC as acquireConnectionRpcClient
    participant CM as connections (ConnectionManager)
    participant Reader as socket reader fiber
    participant Cleanup as onExit cleanup

    C->>WS: GET /ws (Upgrade: websocket)
    WS->>HS: req.upgrade → socket: Socket.Socket
    Note over HS: connId = crypto.randomUUID()<br>writer = yield* socket.writer<br>closeRequested = yield* Deferred.make<void>()
    HS->>RPC: acquireConnectionRpcClient(connId, write)
    Note over RPC: per-connection JSON-RPC originator<br>(internal to the typed Connection)<br>scope-bound: finalizer fails every<br>pending Deferred with NotConnectedError
    RPC-->>HS: originator
    HS->>CM: connections.add({id, write, shutdown, auth: null,<br>lastPong, conversationIds, mutedConversations, originator})
    HS->>Reader: socket.runRaw(data => handleFrame(decode(data)))
    Note over HS,Reader: Effect.raceFirst(reader, Deferred.await(closeRequested))<br>raceFirst (not race): abrupt disconnect still triggers onExit—<br>plain `race` would leak on abnormal close
    Reader-->>Cleanup: connection closes (normal or abrupt)
    Note over Cleanup: if (authCtx) presenceService.setOffline(agentId)
    Note over Cleanup: for hook of disconnectionHooks:<br>runUserHook(hook, {agentId, ownerUserId, connId}, …)<br>SEQUENTIAL — earlier hook's cleanup completes<br>before next hook observes post-close state
    Note over Cleanup: if (authCtx)<br>agentEndpointResolver.remove(agentId, connId)<br>(Slice G1 plan §2.11 — drops multimap entry)
    Note over Cleanup: leaseRegistry.abandon(connId)<br>PENDING → ABANDONED<br>GRANTED/HOLD → EXPIRED-on-disconnect<br>CLAIMED → no-op (load-bearing: in-flight<br>messages/send owns lease via acquireUseRelease)
    Note over Cleanup: presenceService.removeConnection(connId)<br>connections.remove(connId)<br>logInfo("WebSocket disconnected", {connId})
```

## See also

- [§03 Request → response handling](./03-request-response-handling.md)
- [§06 Lease lifecycle](./06-lease-lifecycle.md) — `leaseRegistry.abandon` detail
- [§09 Shutdown sequence](./09-shutdown-sequence.md) — `conn.shutdown` signal
