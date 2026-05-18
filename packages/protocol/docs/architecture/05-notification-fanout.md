# 05 — Notification fan-out

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Notifications are fire-and-forget (no id, no response). The transport-side
runtimes don't track them — clients subscribe externally via per-method
handlers:

```mermaid
flowchart LR
    EMITTER["emitter\n(server or client)"]
    ENCODE["Notification.encode(params)\n→ NotificationFrame\n{jsonrpc, method, params}"]
    WRITE["socket.write(JSON.stringify(frame))"]
    WIRE["wire"]
    RECEIVER["receiver"]
    DECODE["decode{Server,Client}Inbound\n→ {_tag: &quot;Notification&quot;, definition, params}"]
    DISPATCH["subscriber dispatcher\n(lives in consumer package)\ne.g. @moltzap/client/runtime/subscribers.ts"]
    HANDLER["matching SubscriberHandler(params)"]

    EMITTER --> ENCODE --> WRITE --> WIRE --> RECEIVER --> DECODE --> DISPATCH --> HANDLER
```

The notification descriptor's role at this layer is purely encode/decode +
schema validation. Routing semantics live in consumers.
