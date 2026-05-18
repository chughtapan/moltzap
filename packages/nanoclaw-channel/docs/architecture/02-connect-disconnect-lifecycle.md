# connect / disconnect Lifecycle

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`connect()` and `disconnect()` are Promise-boundary adapters — they wrap
Effect values to satisfy nanoclaw's `Channel` interface (see `ownsJid` in
`types.ts`). The channel does not own any WS socket directly; all transport
is in `MoltZapChannelCore` (from `@moltzap/client`).

```
  Caller (nanoclaw router / test harness)
       │
       │ channel.connect()                    channels/moltzap.ts → connect()
       ▼
  Effect.runPromise(
    this.core.connect()                       @moltzap/client
      .pipe(
        Effect.tap(() =>
          Effect.logInfo("MoltZap connected")
            .pipe(Effect.annotateLogs({ channel: "moltzap" }))
        )
      )
  )
       │
       │ resolves when WS handshake complete
       ▼
  channel.isConnected() → true               (delegates to core.isConnected())


  Caller
       │
       │ channel.disconnect()                 channels/moltzap.ts → disconnect()
       ▼
  Effect.runPromise(this.core.disconnect())
       │
       │ Effect never fails; resolves after WS close
       ▼
  channel.isConnected() → false

  NOTE: disconnect does NOT clear dispatchLeasesByJid.
        Lease entries survive across reconnects (intentional —
        the server owns lease state; stale local entries are harmless
        because a second send for the same lease hits the CONSUMED
        server path and surfaces MoltZapChannelError, §3.4).

  onDisconnect / onReconnect hooks (wired in constructor):
       │ core detects drop
       ▼
  core fires onDisconnect callback
       │
       ▼  Effect.runFork(logWarning("MoltZap disconnected"))
          (fire-and-forget; nanoclaw router sees isConnected() → false)

       │ core re-establishes WS
       ▼
  core fires onReconnect callback
       │
       ▼  Effect.runFork(logInfo("MoltZap reconnected"))
```

---

Previous: [01 — Channel Construction + registerChannel Hook](./01-construction-and-registry.md)
Next: [03 — Inbound Flow](./03-inbound-flow.md)
