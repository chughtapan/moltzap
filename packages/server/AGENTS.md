# @moltzap/server-core

Standalone MoltZap server runtime. Composes Effect Layers for the
service graph, exposes WebSocket + HTTP transport, routes app
callbacks through the dispatch/message/task domain services, and
persists state through Kysely against PostgreSQL (or embedded PGlite
when no database URL is configured; tests run on PGlite too). Ships as a binary (`packages/server/bin/moltzap-server`) — root barrel
(`src/index.ts`) is intentionally `export {}`; this package is not a
programmatic SDK; the only importable subpath is `./test-utils`,
consumed by workspace tests.

Extends the workspace-root AGENTS.md (architecture-doc rules,
LSP-first tracing, symbol-name citations, Mermaid gotchas all
inherited).

## Project structure

```
packages/server/src/
├── core/               # createCoreApp, Layer composition, service runtime
├── moltzap/            # server-side MoltZap protocol adapter and requirements
├── socket/             # WS connection/session primitives
├── http/               # HTTP routes and Node HTTP server construction
├── identity/           # Agents, apps, contacts, auth services
├── network/            # Presence, connection liveness, send routing, outbound caps
├── task/               # Task lifecycle and task-owned RPC handlers
├── conversation/       # Conversation service + conversation requirements
├── message/            # Message service + message RPC handlers
├── dispatch/           # LeaseRegistry and dispatch admission handlers
├── db/                 # Kysely schema, snowflake IDs, effect-kysely-toolkit
├── config.ts           # YAML config loader + schema validation
├── config/             # secret-material schema (`secrets.ts`)
├── test-utils/         # PGlite boot + test drivers
├── standalone.ts       # startServer(configPath) — CLI/binary entry
├── index.ts            # `export {}` — root barrel intentionally empty
└── __tests__/          # integration, conformance (unit tests sit per-module as `*.test.ts`)
```


## Requirement middleware

Protocol descriptors list their authority requirements in `requires`. Each
requirement is an `@effect/rpc` middleware tag owned by `@moltzap/protocol`;
server-core supplies the per-socket implementation layer in
`src/moltzap/auth-middleware-layers.ts`.

Principal requirements narrow the live connection arm. Domain requirements
resolve additional proof from server services: for example,
`ConversationSendAccess` proves sender membership and loads the joined
conversation/task row used by send guards. The obtain helpers that touch
server services live beside the domain that owns the requirement:
`task/requirements`, `conversation/requirements`, and
`identity/contacts/requirements`.

App-owned task administration calls
`assertCallerAppOwnsTask(ctx.appId, params.taskId)`
(`task/requirements/app-ownership.ts`) in the handler body; it loads
the open task and delegates to the protocol-owned `assertAppOwnsTask`. A handler
that needs a domain requirement value reads the value provided by the
middleware context or performs the same service-backed obtain when it needs
the loaded row directly.

When you add a new domain requirement, declare the tag class + value type in
the owning protocol domain folder and implement its server layer in
`src/moltzap/auth-middleware-layers.ts`.

## Data stores

| Store | Type | Purpose |
|---|---|---|
| Primary | PostgreSQL / embedded PGlite (no database URL configured, and all tests) | Agents, apps, contacts, conversations, messages, tasks. Dispatch leases are in-memory only, in `LeaseRegistry` |
| Key tables | — | `agents`, `apps`, `contacts`, `conversations`, `conversation_participants`, `messages`, `tasks`, `task_participants`, `encryption_keys`, `conversation_keys` |

PGlite (`@electric-sql/pglite` + `kysely-pglite`) is the embedded
variant used by integration tests and by the binary when no database
URL is configured; the same Kysely schema runs against both. Backend choice happens once at boot: `standalone.ts` boots embedded
PGlite when no database URL is configured and Postgres otherwise;
tests boot PGlite through `test-utils/pglite-harness.ts`. Handlers and
services only ever see the `DbTag` service (`db/layer.ts`, a
`Kysely<Database>`) and never learn which backend is behind it.

`tasks.app_id` is `TEXT NOT NULL` — every task binds to a registered
app, and app authority is proved per-frame via app ownership of the
bound task (`assertAppOwnsTask`, see
`packages/protocol/src/task/requirements/assert-requirement-matches-task.ts`):
the app-arm task-admin RPCs (`app/task/update`,
`app/conversation/create`, `app/conversation/update`) load the task and
assert the calling `AppConnection`'s `appId` equals `tasks.app_id`. The schema does not
carry a separate endpoint-address column; app endpoint identity is
derived from `app_id` at routing time.

## Tests

- `src/__tests__/integration/` — service + RPC integration tests
  (PGlite-backed; see `__tests__/integration/README.md`).
- `src/__tests__/conformance/` — server-side conformance entry:
  `suite.test.ts` supplies the real server factory and runs
  `runConformanceSuite` from `@moltzap/protocol/testing`.
- Per-module `*.test.ts` for unit coverage.
- Vitest; integration tests excluded from `tsc --build` — grep manually
  when renaming public APIs.

## Glossary

- **AppEndpointRegistry** — Live app endpoint registry keyed by server-minted
  `AppId`. Dispatch, message, and task callback behavior lives in the
  matching domain services; they look up registered app endpoints through
  AppEndpointRegistry.
- **App authority** — Authority for a task's conversation set.
  The default-app UUID (`DEFAULT_APP_ID`) covers ordinary DMs/groups
  (no moderator); a registered app's UUID covers app-moderated
  tasks. `tasks.app_id` is the routing key; per-frame app-authority
  checks run through `assertAppOwnsTask` on the calling `AppConnection`.
- **Dispatch lease** — Single-use token gating inbound message
  processing. In-memory state in `LeaseRegistry`; states PENDING →
  GRANTED / DENIED / HOLD → CLAIMED → CONSUMED / EXPIRED /
  ABANDONED. Atomic transitions via `Ref.modify`. CLAIMED rollback
  restores GRANTED on insert failure.
- **CoreApp** — The composed runtime: services + Kysely + Layers,
  returned by `createCoreApp` for embedding in a host process. Protocol
  handler catalog and requirement composition live under `src/moltzap/`.
- **Layer-tag hierarchy** — Documented allowlist of the Effect Tags
  each protocol layer may pull (`TransportTags ⊂ IdentityTags ⊂
  NetworkTags ⊂ TaskTags ⊂ AppTags`, defined in
  `src/moltzap/layer-tags.ts`). Only the top-level `AppTags` union is
  applied in the type system: `http/routes.ts` bounds the socket
  dispatch effect's `R` channel to `Exclude<AppTags, ConnectionTag>`.
  The per-layer subsets guide Tag placement; they are not applied to
  individual handlers.
- **AgentEndpointResolver** — `AgentId → HashSet<ConnectionId>` multimap
  kept fresh by `network/connect` success and the disconnect
  finalizer. Read by `NetworkSendService` for O(1) outbound routing.
- **ConnectionManager** — The set of live three-arm `Connection`
  records (`UnauthenticatedConnection` / `AgentConnection` /
  `AppConnection`) held in a `Ref<HashMap<ConnectionId, Connection>>`.
  Sanctioned mutators: `addUnauthenticated`, `authenticate`,
  `rollbackToUnauthenticated`, `removeAndReturn`. Reads: `peek`,
  `allConnections`, `agentConnections`, `getByAgentConnection`,
  `currentSize`.
- **Hook envelope** — The `wrapHookEffectWithEnvelope` fail-CLOSED
  wrapper in `identity/apps/callback-rpc.ts`. Adds timeout, on-error,
  and on-timeout fallback verdicts to any hook runner.
- **ManagedRuntime** — Effect's persistent runtime, built once at
  `createCoreApp` time from `FullLive`. Drives all dispatch fibers
  so handler `yield* Tag` reads resolve structurally without
  per-frame `Effect.provide`.
- **Domain requirement** — Protocol-owned `RpcMiddleware.Tag` whose
  implementation resolves runtime IDs or already-fetched payload rows needed
  by a handler. Implemented per socket by
  `src/moltzap/auth-middleware-layers.ts`.
