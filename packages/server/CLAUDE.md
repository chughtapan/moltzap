# @moltzap/server-core

Standalone MoltZap server runtime. Composes Effect Layers for the
service graph, exposes WebSocket + HTTP transport, routes app
callbacks through the dispatch/message/task domain services, and
persists state through Kysely against PostgreSQL (or PGlite under
test). Ships as a binary (`packages/server/bin/moltzap-server`) — root barrel
(`src/index.ts`) is intentionally `export {}`; this package is not a
programmatic SDK and consumers must not import from it.

Extends the workspace-root CLAUDE.md (architecture-doc rules,
LSP-first tracing, symbol-name citations, Mermaid gotchas all
inherited).

## Project structure

```
packages/server/src/
├── core/               # createCoreApp, Layer composition, handler catalog
├── socket/             # WS connection lifecycle, principal gates, requirement layers
├── http/               # HTTP routes and Node HTTP server construction
├── identity/           # Agents, apps, contacts, auth services
├── network/            # Presence, connection liveness, send routing, outbound caps
├── task/               # Task lifecycle and task-owned RPC handlers
├── conversation/       # Conversation service + conversation requirements
├── message/            # Message service + message RPC handlers
├── dispatch/           # LeaseRegistry and dispatch admission handlers
├── db/                 # Kysely schema, snowflake IDs, effect-kysely-toolkit
├── config.ts           # YAML config loader + schema validation
├── test-utils/         # PGlite boot + test drivers
├── standalone.ts       # startServer(configPath) — CLI/binary entry
├── index.ts            # `export {}` — root barrel intentionally empty
└── __tests__/          # unit, integration, conformance
```


## Requirement middleware

Protocol descriptors list their authority requirements in `requires`. Each
requirement is an `@effect/rpc` middleware tag owned by `@moltzap/protocol`;
server-core supplies the per-socket implementation layer in
`src/socket/auth-middleware-layers.ts`.

Principal requirements narrow the live connection arm. Domain requirements
resolve additional proof from server services: for example,
`ConversationSendAccess` proves sender membership and loads the joined
conversation/task row used by send guards. The obtain helpers that touch
server services live beside the domain that owns the requirement:
`task/requirements`, `conversation/requirements`, and
`identity/contacts/requirements`.

App-owned task administration loads the task and calls
`assertAppOwnsTask(appConn.auth.appId, task)` in the handler body. A handler
that needs a domain requirement value reads the value provided by the
middleware context or performs the same service-backed obtain when it needs
the loaded row directly.

When you add a new domain requirement, declare the tag class + value type in
the owning protocol domain folder and implement its server layer in
`src/socket/auth-middleware-layers.ts`.

## Data stores

| Store | Type | Purpose |
|---|---|---|
| Primary | PostgreSQL (prod) / PGlite (tests) | Agents, conversations, messages, tasks, leases (in-memory copy) |
| Key tables | — | `agents`, `users`, `sessions`, `conversations`, `conversation_participants`, `messages`, `tasks`, `dispatches` |

PGlite (`@electric-sql/pglite` + `kysely-pglite`) is the in-memory
variant used by integration tests; the same Kysely schema runs against
both. The `createDb` factory (`db/client.ts`) dispatches on config —
`db.kind = "pg"` returns a real `Kysely<Database>`, `db.kind = "pglite"`
returns the in-memory variant. Handlers and services never branch on
`db.kind`.

`tasks.app_id` is `TEXT NOT NULL` — every task binds to a registered
app, and TM authority is proved per-frame via app-ownership of the
  bound task (`assertAppOwnsTask`, see
`packages/protocol/src/task/requirements/assert-requirement-matches-task.ts`):
the 8 task-admin RPCs load the task and assert the calling
`AppConnection`'s `appId` equals `tasks.app_id`. The schema does not
carry a separate endpoint-address column; app endpoint identity is
derived from `app_id` at routing time.

## Tests

- `src/__tests__/integration/` — service + RPC integration tests
  (PGlite-backed; see `__tests__/integration/README.md`).
- `src/__tests__/conformance/` — server-side conformance harness
  (re-uses `@moltzap/protocol/testing/conformance`).
- Per-module `*.test.ts` for unit coverage.
- Vitest; integration tests excluded from `tsc --build` — grep manually
  when renaming public APIs.

## Glossary

- **AppHost** — Live app endpoint registry keyed by server-minted
  `AppId`. Dispatch, message, and task callback behavior lives in the
  matching domain services; they look up registered app endpoints through
  AppHost.
- **TM (Task Manager)** — Authority for a task's conversation set.
  The default-app UUID (`DEFAULT_APP_ID`) covers ordinary DMs/groups
  (no moderator); a registered app's UUID covers app-moderated
  tasks. `tasks.app_id` is the routing key; per-frame TM-authority
  checks run through `assertAppOwnsTask` on the calling `AppConnection`.
- **Dispatch lease** — Single-use token gating inbound message
  processing. In-memory state in `LeaseRegistry`; states PENDING →
  GRANTED / DENIED / HOLD → CLAIMED → CONSUMED / EXPIRED /
  ABANDONED. Atomic transitions via `Ref.modify`. CLAIMED rollback
  restores GRANTED on insert failure.
- **CoreApp** — The composed runtime: services + Kysely + Layers,
  returned by `createCoreApp` for embedding in a host process. The
  static RPC handler table is baked at `createCoreApp` time —
  post-construction method registration is not supported.
- **Layer-tag hierarchy** — TypeScript-enforced constraint on which
  Effect Tags a handler may pull (`TransportTags ⊂ IdentityTags ⊂
  NetworkTags ⊂ TaskTags ⊂ AppTags`); prevents low-layer code from
  depending on high-layer services. Enforced via the `R` channel of
  the handler's Effect.
- **AgentEndpointResolver** — `AgentId → HashSet<ConnId>` multimap
  kept fresh by `network/connect` success and the disconnect
  finalizer. Read by `NetworkSendService` for O(1) outbound routing.
- **ConnectionManager** — The set of live three-arm `Connection`
  records (`UnauthenticatedConnection` / `AgentConnection` /
  `AppConnection`) held in a `Ref<HashMap<ConnId, Connection>>`.
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
  `src/socket/auth-middleware-layers.ts`.
