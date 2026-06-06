# @moltzap/server-core

Standalone MoltZap server runtime. Composes Effect Layers for the
service graph, exposes WebSocket + HTTP transport, runs the
`AppHost` dispatcher for moderator round-trips, and persists state
through Kysely against PostgreSQL (or PGlite under test). Ships as a
binary (`packages/server/bin/moltzap-server`) — root barrel
(`src/index.ts`) is intentionally `export {}`; this package is not a
programmatic SDK and consumers must not import from it.

Extends the workspace-root CLAUDE.md (architecture-doc rules,
LSP-first tracing, symbol-name citations, Mermaid gotchas all
inherited).

## Project structure

```
packages/server/src/
├── app/                # AppHost + composition root
│   ├── server.ts             # createCoreApp — composes Layers, mounts routes
│   ├── app-host.ts           # AppHost — dispatch/* + hook fan-out
│   ├── requirement-middlewares.ts # server-side obtains for protocol requirements
│   ├── handlers/             # apps.handlers, task-request.handler
│   ├── layers.ts             # Tag definitions + Live composition
│   └── types.ts              # CoreConfig, CoreApp, ConnectionHook / DisconnectionHook
├── identity/           # Auth, agents, sessions, participants
├── network/            # Ping, presence, connection liveness, send routing
├── task/               # Conversations, messages, dispatch lease lifecycle
│   └── leases/            # LeaseRegistry — in-memory lease state machine + TTL fibers
├── transport/          # WS connection acquisition, dispatch context, layer-tags
├── crypto/             # Envelope encryption, key rotation, webhook HMAC signing
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
`src/transport/auth-middleware-layers.ts`.

Principal requirements narrow the live connection arm. Domain requirements
resolve additional proof from server services: for example,
`ConversationSendAccess` proves sender membership and loads the joined
conversation/task row used by send guards. The obtain helpers that touch
server services live in `src/app/requirement-middlewares.ts` or beside the
service that owns the query.

App-owned task administration loads the task and calls
`assertAppOwnsTask(appConn.auth.appId, task)` in the handler body. A handler
that needs a domain requirement value reads the value provided by the
middleware context or performs the same service-backed obtain when it needs
the loaded row directly.

When you add a new domain requirement, declare the tag class + value type in
the owning protocol domain folder and implement its server layer in
`src/transport/auth-middleware-layers.ts`.

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

- **AppHost** — Server-side dispatcher routing app-callback RPCs
  (`dispatch/authorize`, `messages/authorize`, hook RPCs) to the
  registered moderator connection. Owns the in-process + remote hook
  registries; emits `dispatch/release` and `participants/removed`
  notifications post-verdict.
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
  wrapper in `app/app-host.ts`. Adds timeout, on-error, and
  on-timeout fallback verdicts to any hook runner.
- **ManagedRuntime** — Effect's persistent runtime, built once at
  `createCoreApp` time from `FullLive`. Drives all dispatch fibers
  so handler `yield* Tag` reads resolve structurally without
  per-frame `Effect.provide`.
- **Domain requirement** — Protocol-owned `RpcMiddleware.Tag` whose
  implementation resolves runtime IDs or already-fetched payload rows needed
  by a handler. Implemented per socket by
  `src/transport/auth-middleware-layers.ts`.
