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
│   ├── capability-providers.ts # serverCapabilityProviders obtain table
│   ├── handlers/             # apps.handlers, task-request.handler
│   ├── layers.ts             # Tag definitions + Live composition (Tier 1-6)
│   └── types.ts              # CoreConfig, CoreApp, branded IDs + ConnectionHook / DisconnectionHook (no generic Hook<T,R>)
├── identity/           # Auth, agents, sessions, participants
├── network/            # Ping, presence, connection liveness, send routing
├── task/               # Conversations, messages, dispatch lease lifecycle
│   └── leases/            # LeaseRegistry — in-memory lease state machine + TTL fibers
├── transport/          # WS connection acquisition, dispatch context, layer-tags
├── crypto/             # Envelope encryption, key rotation, webhook HMAC signing
├── db/                 # Kysely schema, snowflake IDs, effect-kysely-toolkit
├── config.ts           # YAML config loader + TypeBox schema validation (consolidated post-#680)
├── test-utils/         # PGlite boot + test drivers
├── standalone.ts       # startServer(configPath) — CLI/binary entry
├── index.ts            # `export {}` — root barrel intentionally empty post-#680
└── __tests__/          # unit, integration, conformance
```


## R-channel capability tokens

Privileged service methods declare their preconditions in their
type signature via Effect's R channel. The descriptor declares which
capability tags the handler needs; the dispatcher auto-provisions
them per frame from a shared provider table — handlers `yield*` the
tag directly with no hand-piped `Effect.provideServiceEffect` chain
at the call site.

```ts
// protocol/task/messages.ts — descriptor declares its capabilities
export const MessagesSend = defineRpc({
  name: "messages/send",
  params: MessagesSendParams,
  result: MessagesSendResult,
  capabilities: [
    { tag: MessageSendPermission, argsOf: (p, ctx) => ({ /* ... */ }) },
  ],
});

// App-arm RPCs (D #705 R3/R7) declare NO descriptor capabilities for
// app-ownership: each handler loads the task and calls
// `assertAppOwnsTask(appConn.auth.appId, task)` directly. e.g.
// `TaskConversationCreate` carries no `capabilities` array — its
// app-ownership + capacity proofs are inline in the handler body.

// service body just yields the tag, no provideServiceEffect at the call site
send(
  /* ... */
): Effect.Effect<MessageResult, MessageServiceError, MessageSendPermission>;

// server/src/app/capability-providers.ts — single source of truth.
// Simple obtains are INLINE here (each has exactly one consumer: this
// table). The #673 `TmAuthority` capability is dissolved (D #705 R7):
// the 8 task-admin RPCs are bound to `defineAppMethod` and each handler
// loads the task + calls `assertAppOwnsTask(appConn.auth.appId, task)`
// directly — there is no capability-provider entry for app-ownership.
export const serverCapabilityProviders = {
  [TaskReadAccess.key]: (args) =>
    Effect.gen(function* () {
      const taskService = yield* TaskServiceTag;
      const { taskId, callerAgentId } = args as TaskAndAgent;
      const task = yield* taskService.loadTaskWithReadAccess(
        taskId,
        callerAgentId,
      );
      return { task, callerAgentId };
    }),
  /* ...ConversationInTask, ContactPolicyAllowsReach inline... */
  // Composites with their own direct consumers live as named functions
  // next to the services they compose:
  [ConversationCreateAuthorization.key]: (args) =>
    obtainConversationCreateAuthorization(args), // task/services/conversation-create-authorization.ts
  [MessageSendPermission.key]: (args) =>
    obtainMessageSendPermission(args), // task/services/message-send-permission.ts
} as const;
```

The dispatcher reads `definition.capabilities` per frame, looks up
each tag's obtain helper in `serverCapabilityProviders`, and threads
`Effect.provideServiceEffect(tag, providerEffect)` over the handler
before invoking it. The compile-time lockstep gate
(`protocol/transport/typed-dispatcher.types-check.ts` Canary 7)
rejects any handler whose R channel references a tag NOT in its
descriptor's `capabilities` array.

`MessagesSend` is the one structural exception: the wire schema
accepts `(conversationId | to | replyToId)` and the handler must
resolve `conversationId` via DB lookup before `MessageSendPermission`
can be obtained, so it stays hand-piped at the handler call site.
See `protocol/task/messages.ts → MessagesSend` for the rationale.

- **`packages/server/src/app/capability-providers.ts`** (file-level
  JSDoc) — provider-table walkthrough, capability shapes, composite
  path, migration recipe.

Capability shapes:

- **Obtain** — queries the DB, produces the capability value + payload
  row. `obtainXxx(...)` returns `Effect<Xxx["Type"], ServiceError, ServiceTag>`.
- **Refine** — validates an already-fetched row (no DB read).
  `refineXxx(row)` returns `Effect<Xxx["Type"], ValidationError>`. The
  refine helpers (`refineTaskActive`, `refineConversationNotArchived`)
  live in `@moltzap/protocol/task/capabilities`.
- **Composite** — collapses an intersection-with-alternative
  authorization set into one tag whose value is a discriminated union,
  because Effect's R channel cannot express "exactly one of N
  alternative tags must be provided" (architect Decision A, #606).
  `MessageSendPermission` is the canonical composite.

When you add a new capability tag, the tag class + value type live in
`packages/protocol/src/task/capabilities/<name>.ts` (so descriptors can
reference them without a layering violation). The obtain logic lives in
`server/src/app/capability-providers.ts`: inline in the provider-table
entry for a simple obtain, or as a named function in
`server/src/task/services/<name>.ts` for a composite that has its own
direct consumer (currently `obtainMessageSendPermission` and
`obtainConversationCreateAuthorization`). Capability tags are collected
by the `CapabilityTags` alias in `transport/layer-tags.ts`;
`defineTaskMethod` / `defineAppMethod` accept them in the handler R
channel so the dispatcher's auto-provision path can fill them from the
descriptor's `capabilities` array.

## Layered RPC method wrappers

`src/transport/define-layered-method.ts` exports `defineNetworkMethod`,
`defineTaskMethod`, `defineAppMethod`. Each wrapper enforces a
per-layer Tag allowlist (`NetworkTags` ⊂ `TaskTags` ⊂ `AppTags`) so a
handler at layer L cannot pull a service that only layer L+1 owns.
See `transport/README.md` for the layer hierarchy and
`transport/layer-tags.ts` for the allowlists (capability tags are a
sibling alias, NOT folded in).

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
`packages/protocol/src/task/capabilities/assert-capability-matches-task.ts`):
the 8 task-admin RPCs load the task and assert the calling
`AppConnection`'s `appId` equals `tasks.app_id`. The schema does not
carry a separate `tm_endpoint_address` column; TM endpoint identity is
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
- **ConnectionManager** — The set of live `MoltZapConnection`
  records. Provides `getByAgent`, `getByConvId`, `add`, `remove`,
  `all`.
- **Hook envelope** — The `wrapHookEffectWithEnvelope` fail-CLOSED
  wrapper in `app/app-host.ts`. Adds timeout, on-error, and
  on-timeout fallback verdicts to any hook runner.
- **ManagedRuntime** — Effect's persistent runtime, built once at
  `createCoreApp` time from `FullLive`. Drives all dispatch fibers
  so handler `yield* Tag` reads resolve structurally without
  per-frame `Effect.provide`.
- **R-channel capability** — Nominal `Context.Tag` whose value
  carries the runtime IDs + already-fetched payload row that a
  `require*` authority check would otherwise fetch inline. Pattern
  documented in `src/app/capability-providers.ts` (file-level JSDoc).
