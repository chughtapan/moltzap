# app/

App endpoint registration, default-app wiring, and the AppHost callback router.
Server boot, layer composition, HTTP routes, and socket handling live in
`core/`, `http/`, and `socket/`.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels (db, crypto, runtime), socket, identity, network, task |
| Imports TO   | (none — `app` is the top protocol layer) |

## Files

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
- `requirement-middlewares.ts` — server-side `obtain` impls for protocol
  requirement middleware; the socket auth layer wires each protocol tag to its
  server services.
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
