# 04 — Notification fan-out

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Notifications are fire-and-forget (no id, no response). The transport-side
runtimes don't track them — clients subscribe externally via per-method
handlers:

```text
emitter (server or client)
   │
   ▼  Notification.encode(params) → NotificationFrame              transport/method.ts → encode
   │       {jsonrpc, method, params}
   │
   ▼  socket.write(JSON.stringify(frame))
                            │
                            ▼  wire
                            │
                            ▼
receiver
   │
   ▼  decode{Server,Client}Inbound  →  {_tag: "Notification", definition, params}
   │
   ▼  subscriber dispatcher  (lives in consumer package, not here)
   │       e.g. `@moltzap/client/runtime/subscribers.ts`
   │
   ▼  matching SubscriberHandler(params)
```

The notification descriptor's role at this layer is purely encode/decode +
schema validation. Routing semantics live in consumers.
