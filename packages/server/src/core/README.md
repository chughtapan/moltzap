# core/

Server boot and composition root: `createCoreApp`, the service-graph Layer
composition, the `ManagedRuntime`, tracing, and connection-hook wiring.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | every domain — it composes the whole service graph |
| Imports TO   | nothing imports `#core` for policy; the standalone entry + a few sites pull hook/runtime tags only |

Boot constructs and wires the service graph but holds no domain policy. The
dependency is one-way (`core → domain`, never back), so there is no boot↔domain
tag cycle.

## Files

- `app.ts` — `createCoreApp`: builds the `CoreApp` (services + Kysely + Layers +
  `ManagedRuntime`) and its graceful `close` / teardown order.
  `ServerBootFailedError`.
- `layers.ts` — `ServicesLive` / `resolveServices`: the service-graph Layer
  composition that wires every domain service.
- `hooks.ts` — `ConnectionHooksTag`: the connection/disconnection hook service.
- `tracing.ts` — OpenTelemetry tracing Layer (provides the `withSpan` exporter).
- `types.ts` — boot-surface types only: `CoreApp`, `ConnectionHook`,
  `DisconnectionHook`.
