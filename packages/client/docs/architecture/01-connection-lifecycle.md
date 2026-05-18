# Connection Lifecycle

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The full bootstrap path: HTTP register → WS connect → `network/connect`
handshake → subscribe → steady state. Reconnect and retry arms are shown
separately.

```text
  caller                  auth.ts            MoltZapWsClient        server
    │                       │                       │                  │
    │──registerAgent()──▶   │                       │                  │
    │  (auth.ts → registerAgent)                    │                  │
    │                       │──POST /api/v1/──────▶ │                  │
    │                       │  auth/register        │──────────────────▶
    │                       │                       │     HTTP 200     │
    │ ◀── {agentId,apiKey,  │ ◀────────────────────────────────────── │
    │       claimUrl}        │                       │                  │
    │                       │                       │                  │
    │   new MoltZapWsClient({serverUrl, agentKey})  │                  │
    │──────────────────────────────────────────────▶│                  │
    │   (ws-client.ts → MoltZapWsClient constructor)│                  │
    │                       │   Refs + ManagedRuntime initialized      │
    │                       │   SubscriberRegistry created             │
    │                       │                       │                  │
    │──subscribe({}, handler)──────────────────────▶│                  │
    │   (service.ts → MoltZapService.connect)       │                  │
    │                       │  registry.register()  │                  │
    │                       │  (subscribers.ts → SubscriberRegistry.register)
    │ ◀── NotificationSubscription ────────────────ー│                  │
    │                       │                       │                  │
    │──connect()───────────────────────────────────▶│                  │
    │   (ws-client.ts → MoltZapWsClient.connect)    │                  │
    │                       │   connectEffect():    │                  │
    │                       │   Scope.make()        │                  │
    │                       │   Socket.makeWebSocket(url, {openTimeout:│
    │                       │     10s}) ────────────▶ TCP open        │
    │                       │     (ws-client.ts → openSocket)         │
    │                       │                       │◀─── WS upgrade ─│
    │                       │   makeJsonRpcClient() │                  │
    │                       │   startTaskCallbackDispatcher()          │
    │                       │     → bounded Queue(8192) + drain fiber  │
    │                       │     (ws-client.ts → startTaskCallbackDispatcher)
    │                       │   ║ readerFiber = runFork(readerEffect()) │
    │                       │     (ws-client.ts → readerEffect)        │
    │                       │                       │                  │
    │                       │   awaitConnectAuth(): │                  │
    │                       │   sendRpc(Connect,    │                  │
    │                       │    {agentKey,          │                  │
    │                       │     minProtocol,      │──JSON-RPC ──────▶│
    │                       │     maxProtocol})      │  "network/connect"
    │                       │   (ws-client.ts → awaitConnectAuth)     │
    │                       │                       │ ◀── HelloOk ────│
    │                       │   _helloOk = value    │                  │
    │ ◀── HelloOk ──────────────────────────────────│                  │
    │   _connected = true   │                       │                  │
    │   _ownAgentId set     │                       │                  │
    │   (service.ts → MoltZapService.connect, post-HelloOk)           │
    │                       │                       │                  │
    │   [steady state: reader fiber loops on socket.runRaw]            │
```

**Reconnect arm** (triggered on reader fiber exit when `closed == false`):

```text
  MoltZapWsClient          scheduleReconnect()     server
    │                              │                  │
    │ reader fiber exits ──▶       │                  │
    │ handleReaderExit():          │                  │
    │   failAllPending("not connected")               │
    │   notifyDisconnect(extractCloseInfo(exit))      │
    │   (ws-client.ts → handleReaderExit)             │
    │   closed? ──No──▶ scheduleReconnect()           │
    │                              │                  │
    │   reconnectFiber = runFork(  │                  │
    │     attempt.pipe(            │                  │
    │       retry(exponential(1s,  │                  │
    │         ×2, cap 30s) +       │                  │
    │         jitter)))            │                  │
    │   (ws-client.ts → scheduleReconnect)            │
    │                              │──connectEffect()─▶
    │                              │ ◀── HelloOk ─────│
    │   onReconnect(helloOk) ◀─────│                  │
    │   (service.ts → MoltZapService.onReconnect)     │
```

**State that survives reconnect**: `SubscriberRegistry` entries (registered
before `connect()`), `appCallbackHandlersRef` (server-RPC handlers),
`ManagedRuntime`. Per-connection `ConnState` (scope, reader fiber, queue,
dispatcher scope) is rebuilt fresh on each `connectEffect()` call.

**State that does NOT survive reconnect**: in-flight RPC Deferreds (all
failed via `failAllPending` on disconnect), the previous `JsonRpcClient`
instance, the previous drain fiber.

See also: [State Machines](./07-state-machines.md) for the connection state
machine that formalises these transitions.
