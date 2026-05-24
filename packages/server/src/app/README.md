# app/

App-host, app registration, capability provider table, top-level server boot, layer composition. (The dispatch lease registry now lives in `task/leases/`.)

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels, transport, identity, network, task |
| Imports TO   | (none — app is the top protocol layer) |

## Files (no folder moves in 2A.2)

- `app-host.ts`
- `capability-providers.ts` — `serverCapabilityProviders` obtain table (keyed by `Context.Tag.key`)
- `config.ts`
- `conversation-app-lookup.ts`
- `core-schema.sql`
- `dev.ts`
- `handlers/apps.handlers.ts`
- `handlers/task-request.handler.ts`
- `hooks.ts`
- `layers.ts` — Tag definitions + Layer composition for the whole stack
- `server.ts` — `createCoreApp`; entry to the dispatcher
- `types.ts`

## Handler shape (post-2A.0)

`apps.handlers.ts` follows the same `Effect.gen { yield* AppHostTag; ... }` pattern as the task and identity handlers.

## layers.ts ownership

Tag definitions and Layer composition stay in `app/layers.ts` even after the move. Tags name what services exist; Layers wire the dependency order. Both are app-layer concerns (the composition root).
