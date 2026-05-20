# Connection Lifecycle

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The full bootstrap path: HTTP register → WS connect → `network/connect`
handshake → subscribe → steady state. Reconnect and retry arms are shown
separately.

```mermaid
sequenceDiagram
    participant caller
    participant auth as auth.ts
    participant wsClient as MoltZapWsClient
    participant server

    caller->>auth: registerAgent()<br>(auth.ts → registerAgent)
    auth->>server: POST /api/v1/auth/register
    server-->>auth: HTTP 200
    auth-->>caller: {agentId, apiKey, claimUrl}

    caller->>wsClient: new MoltZapWsClient({serverUrl, agentKey})<br>(ws-client.ts → MoltZapWsClient constructor)
    Note over wsClient: Refs + ManagedRuntime initialized<br>SubscriberRegistry created

    caller->>wsClient: subscribe({}, handler)<br>(service.ts → MoltZapService.connect)
    Note over wsClient: registry.register()<br>(subscribers.ts → SubscriberRegistry.register)
    wsClient-->>caller: NotificationSubscription

    caller->>wsClient: connect()<br>(ws-client.ts → MoltZapWsClient.connect)
    Note over wsClient: connectEffect():<br>Scope.make()<br>Socket.makeWebSocket(url, {openTimeout: 10s})<br>(ws-client.ts → openSocket)
    wsClient->>server: TCP open
    server-->>wsClient: WS upgrade
    Note over wsClient: per-frame originator is internal to the typed Connection<br>startTaskCallbackDispatcher()<br>→ bounded Queue(8192) + drain fiber<br>(ws-client.ts → startTaskCallbackDispatcher)<br>readerFiber = runFork(readerEffect())<br>(ws-client.ts → readerEffect)

    Note over wsClient: awaitConnectAuth():<br>sendRpc(Connect, {agentKey, minProtocol, maxProtocol})<br>(ws-client.ts → awaitConnectAuth)
    wsClient->>server: JSON-RPC "network/connect"
    server-->>wsClient: HelloOk
    Note over wsClient: _helloOk = value
    wsClient-->>caller: HelloOk
    Note over caller: _connected = true<br>_ownAgentId set<br>(service.ts → MoltZapService.connect, post-HelloOk)

    Note over wsClient,server: steady state: reader fiber loops on socket.runRaw
```

**Reconnect arm** (triggered on reader fiber exit when `closed == false`):

```mermaid
sequenceDiagram
    participant wsClient as MoltZapWsClient
    participant reconnect as scheduleReconnect()
    participant server

    Note over wsClient: reader fiber exits
    Note over wsClient: handleReaderExit():<br>failAllPending("not connected")<br>notifyDisconnect(extractCloseInfo(exit))<br>(ws-client.ts → handleReaderExit)
    Note over wsClient: closed? → No → scheduleReconnect()
    Note over wsClient: reconnectFiber = runFork(<br>  attempt.pipe(<br>    retry(exponential(1s, ×2, cap 30s) + jitter)))<br>(ws-client.ts → scheduleReconnect)
    reconnect->>server: connectEffect()
    server-->>reconnect: HelloOk
    reconnect-->>wsClient: onReconnect(helloOk)<br>(service.ts → MoltZapService.onReconnect)
```

**State that survives reconnect**: `SubscriberRegistry` entries (registered
before `connect()`), `ManagedRuntime`. The handler set for inbound
server-initiated RPCs survives by construction — handlers are passed
at `MoltZapWsClient` construction time (static handler table) and are
intrinsic to the instance; reconnect rebuilds the underlying connection
with the same handler set. Per-connection `ConnState` (scope, reader
fiber, queue, dispatcher scope) is rebuilt fresh on each `connectEffect()`
call.

**State that does NOT survive reconnect**: in-flight RPC Deferreds (all
failed via `failAllPending` on disconnect), the previous originator
instance, the previous drain fiber.

See also: [State Machines](./state-machines.md) for the connection state
machine that formalises these transitions.
