# app/

App-host, lease registry, top-level server boot, layer composition,
HTTP routes, WS socket handler.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels (db, crypto, runtime), transport, identity, network, task |
| Imports TO   | (none — `app` is the top protocol layer) |

## Files

- `server.ts` — `createCoreApp` + `closeCoreAppEffect` (composition root).
- `layers.ts` — Tag definitions + `ServicesLive` tier composition.
- `app-host.ts` — `AppHost` class; hook envelope + 3-step resolution
  (in-process → remote → synthetic default) for `dispatch/authorize`
  and `messages/authorize`.
- `lease-registry.ts` — `LeaseRegistry` interface + in-memory
  implementation; lease state machine (PENDING → GRANTED / DENIED /
  HOLD → CLAIMED → CONSUMED / EXPIRED / ABANDONED).
- `capability-providers.ts` — `serverCapabilityProviders` table.
  File-level JSDoc covers the full R-channel capability pattern and
  the migration recipe for new capabilities.
- `capabilities/` — obtain helpers per capability tag (`TmAuthority`,
  `ConversationParticipantAccess`, …); see `capabilities/README.md`.
- `http-routes.ts` — `makeCoreHttpApp`; `/health`, `/ws`, auth
  register / claim, optional admin route.
- `socket-handler.ts` — `makeSocketHandler` + `handleFrame`; the
  per-frame wrapper that runs the typed dispatcher.
- `conversation-app-lookup.ts` — derives a conversation's
  app-binding (the `app_id IS NULL` discriminator) for
  `messages/authorize` routing.
- `hooks.ts` — generic `Hook<TContext, TResult>` shape and the
  concrete hook types (`TaskAuthorizeDispatchHook`,
  `MessageAuthorizeHook`).
- `types.ts` — `CoreConfig`, `CoreApp` surface types.
- `node-http-server.ts` — `@effect/platform-node` HTTP server wiring.
- `logging.ts`, `dev.ts`, `server-constants.ts` — small helpers.
- `handlers/apps.handlers.ts` — `apps/*` RPC handlers (register +
  authorize callbacks).

## layers.ts ownership

Tag definitions and Layer composition live in `layers.ts` even
though Tags name lower-layer services. Tags say WHAT services exist;
Layers wire the dependency order. Both are app-layer concerns (the
composition root sits at the top of the DAG).
