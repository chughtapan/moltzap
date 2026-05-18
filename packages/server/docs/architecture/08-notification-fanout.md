# Notification Fan-out (PresenceService example)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Most notifications originate inside a service and reach the wire via
`ConnectionManager.broadcast` or per-connection `conn.write`. The
`PresenceEventSink` indirection lets the service emit events without
knowing about `ConnectionManager` directly:

```mermaid
flowchart LR
    PS["PresenceService.setOnline(agentId)<br/><i>network/services/presence.service.ts</i>"]
    Sink["sink.emit({tag: 'PresenceChanged', agentId, status: 'online', ts})<br/>sink = createConnectionFanOutPresenceEventSink({connections})<br/><i>network/services/presence-event-sink.ts</i>"]
    Fan["for conn of connections.all():<br/>if conn.subscribesTo(PresenceChanged):<br/>conn.write(JSON.stringify(PresenceChanged.encode(params)))"]
    FF["fire-and-forget<br/>sink errors logged but don't block setOnline"]

    PS -->|"emit"| Sink
    Sink -->|"fan-out"| Fan
    Fan --> FF
```

This pattern (service emits typed events, sink fans out) repeats for
participants/{added,removed}, message delivery webhook fan-out, and
dispatch/release. The single-write-side helps trace lookups: every wire
emission has one originating service.

## See also

- [§02 WebSocket connection lifecycle](./02-ws-connection-lifecycle.md) — `conn.write` set up at connection time
- [§04 Server-initiated callback](./04-server-initiated-callback.md) — `dispatch/release` notification emitted post-verdict
