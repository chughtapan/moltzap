# core/

Server boot and composition root: `createCoreApp`, the service-graph Layer
composition, and the `ManagedRuntime`.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | every domain — it composes the whole service graph |
| Imports TO   | nothing imports `#core` for policy; the standalone entry and protocol adapters use boot/runtime types |

Boot constructs and wires the service graph but holds no domain policy. The
dependency is one-way (`core → domain`, never back), so there is no boot↔domain
tag cycle.

## Files

- `app.ts` — `createCoreApp`: builds the `CoreApp` (services + Kysely + Layers +
  `ManagedRuntime`) and its graceful `close` / teardown order.
  `ServerBootFailedError`.
- `layers.ts` — `ServicesLive` / `resolveServices`: the service-graph Layer
  composition that wires every domain service.
- `types.ts` — boot-surface types only: `CoreApp`.
