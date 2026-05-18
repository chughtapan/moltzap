# `stopAccount` Lifecycle

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```mermaid
sequenceDiagram
    participant OC as OpenClaw runtime
    participant Entry as openclaw-entry.ts
    participant Clients as activeClients Map
    participant Svc as MoltZapService

    OC->>Entry: gateway.stopAccount(ctx)<br/>ctx = { accountId, log? }
    Entry->>Clients: activeClients.get(ctx.accountId)

    alt service found
        Entry->>Entry: ctx.log?.info?.("MoltZap: stopping")
        Entry->>Svc: service.close() — MoltZapService.close()
        Note over Svc: closes WebSocket transport;<br/>WsClient fires "disconnect" event →<br/>core.connected = false;<br/>disconnectHandlers called (log.warn + setStatus)
        Entry->>Clients: activeClients.delete(ctx.accountId)
    else service not found
        Note over Entry: no-op; idempotent
    end

    Entry-->>OC: return Promise.resolve() — always resolves immediately
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

```mermaid
flowchart TD
    A["stopAccount calls service.close()"] --> B["WS closes — no new 'message' events fired"]
    B --> C["consumerFiber is still alive\ninboundQueue drains to empty\nthen blocks on Queue.take forever"]
    B --> D["activeClients entry deleted\nfuture sendText for this accountId\nreceives MoltZapClientNotConnectedError"]
    B --> E["Existing in-flight inbound handler continues to run\nservice.close() does NOT interrupt the Effect fiber"]

    subgraph Idempotency
        F["First stopAccount call\nservice found → close() + delete"] --> G["Safe"]
        H["Subsequent stopAccount calls\nservice not found → no-op"] --> I["Safe"]
        J["No mutex needed\nJavaScript event loop is single-threaded"]
    end

    subgraph Contrast ["Contrast with abort path (§3.1 Path B)"]
        K["abortSignal handler calls\nEffect.runPromise(core.disconnect())"] --> L["Fiber.interrupt(consumerFiber)\n+ service.close()"]
        M["stopAccount does NOT\ninterrupt the fiber"]
    end
```

---

See also:
- [01-start-account-lifecycle.md](01-start-account-lifecycle.md) — the startup counterpart, and the abort path that does interrupt the fiber
