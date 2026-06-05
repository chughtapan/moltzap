# app/

App-host, app registration, capability middlewares, top-level
server boot, layer composition, HTTP routes, WS socket handler. (The
dispatch lease registry lives in `task/leases/`.)

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels (db, crypto, runtime), transport, identity, network, task |
| Imports TO   | (none — `app` is the top protocol layer) |

## Files

- `server.ts` — `createCoreApp` (composition root) + the boot Effect
  that wires Layers, services, and HTTP/WS routes.
- `layers.ts` — Tag definitions + `ServicesLive` tier composition for
  the whole stack.
- `app-host.ts` — `AppHost` class; hook envelope + per-policy switch
  (unknown-app fail-closed / static policy resolved in-process /
  `kind: "hook"` round-trip over the endpoint originator) for
  `dispatch/authorize`, `messages/authorize`, and `task/create`.
- `app-registration.ts` — app registration + the `AppEndpoint`
  (`{ connId, originator }`) every app carries.
- `default-app.ts` — built-in unmoderated default app wiring.
  Registers a manifest declaring the three open static policies with an
  inert endpoint; AppHost resolves each in-process (`dispatch_authorize
  → grant`, `message_authorize → forwardAllExceptSender`, `task_create →
  accept`).
- `capability-middlewares.ts` — one `CapabilityMiddleware` per cap
  (`provides` / `derivePayload` / `obtain`), woven at the binding site by
  `weaveCaps`. File-level JSDoc covers the full R-channel
  capability pattern and the recipe for new capabilities.
- `http-routes.ts` — `makeCoreHttpApp`; `/health`, `/ws`, auth
  register / claim, optional admin route.
- `server.ts` — `createCoreApp`; wires protocol `MoltZapServer` to
  server-core handlers, middleware, and cleanup hooks.
- `conversation-app-lookup.ts` — derives a conversation's
  app-binding (the `app_id IS NULL` discriminator) for
  `messages/authorize` routing.
- `types.ts` — `CoreConfig`, `CoreApp` surface types.
- `config.ts` — `CoreConfig` schema + loader helpers; owns
  `DEFAULT_SERVER_PORT`.
- `node-http-server.ts` — `@effect/platform-node` HTTP server wiring.
- `core-schema.sql` — bundled DDL for fresh schemas.
- `handlers/apps.handlers.ts` — `apps/*` RPC handlers (register +
  authorize callbacks).
- `handlers/task-request.handlers.ts` — `task/request` entry point;
  mints the initial conversation server-side after the app's
  `task/create` accept verdict.

## Handler shape

`apps.handlers.ts` follows the same `Effect.gen { yield* AppHostTag; ... }`
pattern as the task and identity handlers.

## layers.ts ownership

Tag definitions and Layer composition live in `layers.ts` even
though Tags name lower-layer services. Tags say WHAT services exist;
Layers wire the dependency order. Both are app-layer concerns (the
composition root sits at the top of the DAG).
