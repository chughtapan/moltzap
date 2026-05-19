# connect / disconnect Lifecycle

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`connect()` and `disconnect()` are Promise-boundary adapters — they wrap
Effect values to satisfy nanoclaw's `Channel` interface (see `ownsJid` in
`types.ts`). The channel does not own any WS socket directly; all transport
is in `MoltZapChannelCore` (from `@moltzap/client`).

```mermaid
sequenceDiagram
    participant Caller as Caller (nanoclaw router / test harness)
    participant Channel as MoltZapChannel (channels/moltzap.ts)
    participant Core as MoltZapChannelCore (@moltzap/client)

    Note over Caller,Core: connect()
    Caller->>Channel: channel.connect()
    Channel->>Core: Effect.runPromise(core.connect())
    Core-->>Channel: WS handshake complete
    Channel-->>Caller: resolves
    Note over Channel: channel.isConnected() → true (delegates to core.isConnected())

    Note over Caller,Core: disconnect()
    Caller->>Channel: channel.disconnect()
    Channel->>Core: Effect.runPromise(core.disconnect())
    Note over Core: Effect never fails— resolves after WS close
    Core-->>Channel: resolved
    Channel-->>Caller: resolves
    Note over Channel: channel.isConnected() → false
    Note over Channel: disconnect does NOT clear leaseStore — lease entries survive across reconnects (intentional— server owns lease state— stale local entries are harmless because a second send hits the CONSUMED server path and surfaces MoltZapChannelError, §3.4)

    Note over Caller,Core: onDisconnect / onReconnect hooks (wired in constructor)
    Core->>Channel: core detects drop → fires onDisconnect callback
    Note over Channel: Effect.runFork(logWarning("MoltZap disconnected"))<br>(fire-and-forget— nanoclaw router sees isConnected() → false)
    Core->>Channel: core re-establishes WS → fires onReconnect callback
    Note over Channel: Effect.runFork(logInfo("MoltZap reconnected"))
```

---

Previous: [01 — Channel Construction + registerChannel Hook](./01-construction-and-registry.md)
Next: [03 — Inbound Flow](./03-inbound-flow.md)
