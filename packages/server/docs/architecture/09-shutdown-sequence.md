# Shutdown Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`CoreApp.close()` (in `app/server.ts → close`) tears down in a specific order so
in-flight work has a chance to finish before its dependencies vanish:

```text
close()
   │
   ▼  messageService.close()
   │     # interrupt in-flight delivery-webhook retries BEFORE scope close
   │     # so pending POSTs don't race the HTTP server teardown
   │
   ▼  appHost.destroy()
   │     # clears manifests, in-process hook registries, remote registrations
   │     # WARNING: runs BEFORE connections close, so an in-flight RPC may
   │     # observe cleared manifests. SHUTDOWN_DRAIN_MS (500ms) sleep below
   │     # is the only mitigation today (tracked in /review output 2026-04-16).
   │
   ▼  for conn of connections.all():
   │     yield* conn.shutdown
   │       # signals the per-connection closeRequested Deferred,
   │       # which unblocks raceFirst → triggers onExit cleanup
   │
   ▼  Effect.sleep(500ms)  ── drain in-flight RPCs
   │
   ▼  Scope.close(appScope, Exit.void)
   │     # tears down NodeHttpServer + upgrade wiring
   │
   ▼  dispatchRuntime.dispose()
   │     # disposes the ManagedRuntime, finalizing service Layers
   │
   ▼  config.dbCleanup?.()
        # optional caller-supplied hook (e.g. PGlite shutdown in tests)
```

## See also

- [§01 Service layer composition](./01-service-layer-composition.md) — `dispatchRuntime` and `FullLive` that are disposed here
- [§02 WebSocket connection lifecycle](./02-ws-connection-lifecycle.md) — `conn.shutdown` / `closeRequested` Deferred detail
