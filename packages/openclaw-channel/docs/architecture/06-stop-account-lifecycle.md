# `stopAccount` Lifecycle

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```
OpenClaw runtime
      │
      │  gateway.stopAccount(ctx)
      │  ctx = { accountId, log? }
      │
      ▼
  service = activeClients.get(ctx.accountId)   (in `openclaw-entry.ts`)
      │
      ├─[service found]
      │   ctx.log?.info?.("MoltZap: stopping")
      │   service.close()          ← MoltZapService.close()
      │   activeClients.delete(ctx.accountId)
      │
      └─[service not found]
          (no-op; idempotent)
      │
      ▼
  return Promise.resolve()        ← always resolves immediately
```

**What `service.close()` tears down:**

`MoltZapService.close()` is defined in `@moltzap/client/src/service.ts`.
It closes the underlying WebSocket transport. The WsClient event loop
fires a "disconnect" event, which:
- sets `core.connected = false`
- calls all `disconnectHandlers` registered via `core.onDisconnect`
  (in `openclaw-entry.ts → startAccount, onDisconnect`: log.warn + setStatus)

`MoltZapChannelCore` itself is NOT explicitly torn down by `stopAccount`.
The consumer fiber (`consumerFiber`) is interrupted only by
`core.disconnect()`, which is NOT called in `stopAccount`. This means:

```
Race: stopAccount vs in-flight inbound
───────────────────────────────────────
  1. stopAccount calls service.close()
  2. WS closes; no new "message" events fired
  3. consumerFiber is still alive but inboundQueue will drain
     to empty and then block on Queue.take forever
  4. activeClients entry is deleted → future sendText for this
     accountId will receive MoltZapClientNotConnectedError
  5. Existing in-flight inbound handler (if in the middle of
     dispatchReplyWithBufferedBlockDispatcher) continues to run
     because service.close() doesn't interrupt the Effect fiber

Idempotency:
  Multiple stopAccount calls for the same accountId:
  - First call: service found, close() + delete → safe
  - Subsequent calls: service not found, no-op → safe
  No mutex needed; JavaScript event loop is single-threaded.

Contrast with abort path (§3.1 Path B):
  abortSignal handler calls Effect.runPromise(core.disconnect()),
  which calls Fiber.interrupt(consumerFiber) in addition to
  service.close(). stopAccount does NOT interrupt the fiber.
```

---

See also:
- [01-start-account-lifecycle.md](01-start-account-lifecycle.md) — the startup counterpart, and the abort path that does interrupt the fiber
