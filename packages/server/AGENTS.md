# @moltzap/server-core

Standalone MoltZap server runtime: Effect Layers for the service
graph, WebSocket + HTTP transport, dispatch/conversation/message domain
services, Kysely persistence on PostgreSQL or embedded PGlite (no
database URL configured, and all tests). Ships as a binary
(`bin/moltzap-server`); the root barrel is intentionally `export {}` —
the only importable subpath is `./test-utils`.

## Structure

```
packages/server/src/
├── core/            # createCoreApp, Layer composition, service runtime
├── moltzap/         # protocol adapter: handler catalog, requirement middleware layers
├── socket/          # WS connection/session primitives
├── http/            # HTTP routes + Node HTTP server
├── identity/        # agents, apps, auth
├── network/         # connection liveness, send routing, outbound caps
├── conversation/    # conversation service + requirements
├── message/         # message service + message RPC handlers
├── dispatch/        # LeaseRegistry + dispatch admission handlers
├── db/              # Kysely schema, snowflake IDs, effect-kysely-toolkit
├── config.ts        # YAML config loader; config/secrets.ts — secret material
├── test-utils/      # PGlite boot + test drivers
├── standalone.ts    # startServer(configPath) — binary entry
└── __tests__/       # integration + conformance (unit tests sit per-module)
```

## Concepts

- **Dispatch lease** — single-use token gating inbound message
  processing; in-memory only, in `LeaseRegistry`
  (`dispatch/lease-registry.ts`). States PENDING → GRANTED / DENIED /
  HOLD → CLAIMED → CONSUMED / EXPIRED / ABANDONED; atomic transitions
  via `Ref.modify`; CLAIMED rollback restores GRANTED on insert
  failure.
- **App authority** — authority over a conversation. `DEFAULT_APP_ID`
  covers ordinary DMs/groups (no moderator); a registered app's UUID
  covers app-moderated conversations. `conversations.app_id`
  (`TEXT NOT NULL`) is the routing key; there is no separate
  endpoint-address column — app endpoint identity derives from
  `app_id` at routing time. The agent opening a conversation names the
  server-minted `appId` that moderates it; `app/conversation/update`
  compares the caller against the stored key via
  `assertCallerAppOwnsConversation`.
- **Domain requirement** — protocol-owned `RpcMiddleware.Tag` whose
  implementation resolves runtime IDs or already-fetched rows for a
  handler (e.g. `ConversationSendAccess` proves sender membership and
  loads the conversation row the send path reads).
  Implemented per socket in `moltzap/auth-middleware-layers.ts`.
- **CoreApp / ManagedRuntime** — `createCoreApp` composes services +
  Kysely + Layers and builds the persistent runtime once from
  `FullLive`; all dispatch fibers run on it, so handler `yield* Tag`
  reads resolve structurally without per-frame `Effect.provide`.
- **ConnectionManager** — live three-arm `Connection` records
  (`UnauthenticatedConnection` / `AgentConnection` / `AppConnection`)
  in a `Ref<HashMap<ConnectionId, Connection>>`. Mutate only via
  `addUnauthenticated`, `authenticate`, `rollbackToUnauthenticated`,
  `removeAndReturn`.
- **AgentEndpointResolver** — `AgentId → HashSet<ConnectionId>`
  multimap kept fresh by `network/connect` success and the disconnect
  finalizer; read by `NetworkSendService` for O(1) outbound routing.
- **AppEndpointRegistry** — live app endpoints keyed by server-minted
  `AppId`; domain services look up registered endpoints through it.
- **Hook envelope** — `wrapHookEffectWithEnvelope`
  (`identity/apps/callback-rpc.ts`): fail-CLOSED wrapper adding
  timeout, on-error, and on-timeout fallback verdicts to any hook
  runner.
- **Layer-tag hierarchy** — allowlist of the Effect Tags each protocol
  layer may pull (`TransportTags ⊂ IdentityTags ⊂ NetworkTags ⊂
  ConversationTags ⊂ AppTags`, `moltzap/layer-tags.ts`). Only `AppTags`
  is
  enforced in types: `http/routes.ts` bounds the socket dispatch
  effect's `R` to `Exclude<AppTags, ConnectionTag>`; the per-layer
  subsets guide Tag placement.

## Code

- Handlers and services depend only on `DbTag` (`db/layer.ts`) and
  never learn which backend is behind it; the Postgres/PGlite choice
  happens once at boot (`standalone.ts` for the binary,
  `test-utils/pglite-harness.ts` for tests).
- Protocol descriptors list authority in `requires`; each requirement
  is an `@effect/rpc` middleware tag owned by `@moltzap/protocol`. To
  add a domain requirement: declare the tag class + value type in the
  owning protocol domain folder, implement its server layer in
  `moltzap/auth-middleware-layers.ts`. Obtain helpers that touch
  server services live beside the owning domain
  (`conversation/requirements`).
- `messages.task_id` is an opaque endpoint label: the sender supplies it
  on `agent/message/send`, the server stamps and echoes it, and no read
  path joins, filters, or validates it.

## Tests

- `src/__tests__/integration/` — service + RPC integration tests
  (PGlite-backed; see its README).
- `src/__tests__/conformance/suite.test.ts` — supplies the real server
  factory to `runConformanceSuite` (`@moltzap/protocol/testing`).
- Per-module `*.test.ts` for unit coverage.
- Tests are excluded from `tsc --build`; `pnpm typecheck:tests`
  type-checks them.
