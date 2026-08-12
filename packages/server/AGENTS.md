# @moltzap/server-core

Standalone MoltZap server runtime: Effect Layers for the service
graph, WebSocket + HTTP transport, conversation/message domain
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
├── identity/        # agent auth + credential keys
├── network/         # connection liveness, send routing, outbound caps
├── conversation/    # conversation service + requirements
├── message/         # message service + message RPC handlers
├── db/              # Kysely schema, database-owned order, effect-kysely-toolkit
├── config.ts        # YAML config loader; config/secrets.ts — secret material
├── test-utils/      # PGlite boot + test drivers
├── standalone.ts    # startServer(configPath) — binary entry
└── __tests__/       # integration + conformance (unit tests sit per-module)
```

## Concepts

- **Conversation membership** — fixed at creation. The creator plus the
  named participants become the `conversation_participants` rows, and
  nothing on the wire mutates them afterwards. Participation is
  therefore the whole read and send gate; conversations carry no
  authority column.
- **Domain requirement** — protocol-owned `RpcMiddleware.Tag` whose
  implementation resolves runtime IDs or already-fetched rows for a
  handler (e.g. `ConversationSendAccess` proves sender membership and
  that the conversation row still exists).
  Implemented per socket in `moltzap/auth-middleware-layers.ts`.
- **Principal gate** — `AuthenticatedAgent` is the only principal
  requirement, so `moltzap/principal-gate.ts` narrows the live arm to
  `AgentContext` or fails `Forbidden`. `ActiveAgent` reuses the same
  narrowing with the active-status check.
- **CoreApp / ManagedRuntime** — `createCoreApp` composes services +
  Kysely + Layers and builds the persistent runtime once from
  `FullLive`; all dispatch fibers run on it, so handler `yield* Tag`
  reads resolve structurally without per-frame `Effect.provide`.
- **ConnectionManager** — live two-arm `Connection` records
  (`UnauthenticatedConnection` / `AgentConnection`) in a
  `Ref<HashMap<ConnectionId, Connection>>`. Mutate only via
  `addUnauthenticated`, `authenticate`, `rollbackToUnauthenticated`,
  `removeAndReturn`.
- **AgentEndpointResolver** — `AgentId → HashSet<ConnectionId>`
  multimap kept fresh by `network/connect` success and the disconnect
  finalizer; read by `NetworkSendService` for O(1) outbound routing.
- **Message storage** — `messages.parts` is plaintext JSONB. The write
  side stringifies the wire `MessageParts`; the read side runs the
  strict `decodeMessageParts` decode, so a hand-edited row cannot reach
  the wire. There is no at-rest encryption or key rotation.
- **Layer-tag hierarchy** — allowlist of the Effect Tags each protocol
  layer may pull (`TransportTags ⊂ IdentityTags ⊂ NetworkTags ⊂
  ServerTags`, `moltzap/layer-tags.ts`). Only `ServerTags` is enforced
  in types: `http/routes.ts` bounds the socket dispatch effect's `R` to
  `Exclude<ServerTags, ConnectionTag>`; the per-layer subsets guide Tag
  placement.

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

## Tests

- `src/__tests__/integration/` — service + RPC integration tests
  (PGlite-backed; see its README).
- `src/__tests__/conformance/suite.test.ts` — supplies the real server
  factory to `runConformanceSuite` (`@moltzap/protocol/testing`).
- Per-module `*.test.ts` for unit coverage.
- Tests are excluded from `tsc --build`; `pnpm typecheck:tests`
  type-checks them.
