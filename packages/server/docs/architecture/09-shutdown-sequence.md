# Shutdown Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`CoreApp.close()` (in `app/server.ts → close`) tears down in a specific order so
in-flight work has a chance to finish before its dependencies vanish:

```mermaid
flowchart LR
    A["close()<br/><i>app/server.ts → close</i>"]
    B["messageService.close()<br/>interrupt in-flight delivery-webhook retries<br/>BEFORE scope close — prevents pending POSTs<br/>racing the HTTP server teardown"]
    C["appHost.destroy()<br/>clears manifests, in-process hook registries,<br/>remote registrations<br/>WARNING: runs BEFORE connections close —<br/>in-flight RPC may observe cleared manifests.<br/>SHUTDOWN_DRAIN_MS (500ms) below is the only<br/>mitigation today (tracked in /review 2026-04-16)"]
    D["for conn of connections.all():<br/>yield* conn.shutdown<br/>signals per-connection closeRequested Deferred,<br/>unblocks raceFirst → triggers onExit cleanup"]
    E["Effect.sleep(500ms)<br/>drain in-flight RPCs"]
    F["Scope.close(appScope, Exit.void)<br/>tears down NodeHttpServer + upgrade wiring"]
    G["dispatchRuntime.dispose()<br/>disposes ManagedRuntime, finalizing service Layers"]
    H["config.dbCleanup?.()\noptional caller-supplied hook<br/>(e.g. PGlite shutdown in tests)"]

    A --> B --> C --> D --> E --> F --> G --> H
```

## See also

- [§01 Service layer composition](./01-service-layer-composition.md) — `dispatchRuntime` and `FullLive` that are disposed here
- [§02 WebSocket connection lifecycle](./02-ws-connection-lifecycle.md) — `conn.shutdown` / `closeRequested` Deferred detail
