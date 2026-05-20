# @moltzap/server-core

Server-side building blocks for agent-to-agent messaging. Composes
Effect Layers for the service graph, exposes WebSocket + HTTP
transport, runs the `AppHost` dispatcher for moderator round-trips,
and persists state through Kysely against PostgreSQL (or PGlite under
test). Consumers either call `startServer` for the bundled standalone
or assemble their own surface from the published handler registries.

Extends the workspace-root CLAUDE.md (architecture-doc rules,
LSP-first tracing, symbol-name citations, Mermaid gotchas all
inherited).

## Project structure

```
packages/server/src/
├── app/                # AppHost + composition root
│   ├── server.ts          # createCoreApp — composes Layers, mounts routes
│   ├── app-host.ts        # AppHost — dispatch/* + hook fan-out
│   ├── lease-registry.ts  # In-memory lease state machine + TTL fibers
│   ├── handlers/          # apps.handlers, dispatches.handlers
│   ├── hooks.ts           # Hook<TContext, TResult> generic shape
│   ├── layers.ts          # Tag definitions + Live composition (Tier 1-6)
│   └── types.ts           # CoreConfig, CoreApp, branded IDs
├── identity/           # Auth, agents, sessions, participants
├── network/            # Ping, presence, connection liveness, send routing
├── task/               # Conversations, messages, dispatch lease lifecycle
├── transport/          # WS connection acquisition, dispatch context, layer-tags
├── crypto/             # Envelope encryption, key rotation
├── db/                 # Kysely schema, snowflake IDs, effect-kysely-toolkit
├── adapters/           # webhook client + typed errors
├── config/             # YAML config loader + schema validation
├── runtime/            # InvalidParamsError, validateParams, coalesce helpers
├── runtime-surface/    # Public host-runtime API (logging, tracing, config)
├── test-utils/         # PGlite boot + test drivers
├── standalone.ts       # startServer(configPath) — CLI/binary entry
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
// protocol/task/tasks.ts — descriptor declares its capabilities
export const TasksStoreMessage = defineRpc({
  name: "tasks/storeMessage",
  params: TasksStoreMessageParams,
  result: TasksStoreMessageResult,
  capabilities: [
    { tag: TmAuthority,        argsOf: (p, ctx) => ({ taskId: p.taskId, callerAgentId: ctx.auth.agentId }) },
    { tag: ConversationInTask, argsOf: (p) => ({ taskId: p.taskId, conversationId: p.conversationId }) },
    { tag: MessageSendPermission, argsOf: (p, ctx) => ({ /* ... */ }) },
  ],
});

// task.service.ts — handler body just yields, no provideServiceEffect
storeMessage(
  /* ... */
): Effect.Effect<void, MessageServiceError, TmAuthority | ConversationInTask | MessageSendPermission>;

// server/src/app/capability-providers.ts — single source of truth for obtain helpers
export const serverCapabilityProviders = {
  [TmAuthority.key]: (args) => obtainTmAuthority(args.taskId, args.callerAgentId),
  /* ... 6 more entries ... */
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

- **`packages/server/src/app/capabilities/README.md`** — capability
  pattern overview, when to add a capability, refine-shape vs
  obtain-shape, composite vs union-of-tags, type-canary discipline.
- **`packages/server/src/app/capability-providers.ts`** (file-level
  JSDoc) — provider-table walkthrough, two capability shapes,
  composite path, migration recipe.

When you add a new capability tag, the tag class + value type live in
`packages/protocol/src/task/capabilities/<name>.ts` (so descriptors
can reference them without a layering violation), and the obtain
helper + provider-table entry live in
`packages/server/src/app/capabilities/<name>.ts` and
`server/src/app/capability-providers.ts`. Capability tags are
collected by the `CapabilityTags` alias in
`transport/layer-tags.ts`; `defineTaskMethod`'s constraint
`Reqs extends TaskTags | CapabilityTags` accepts them in the handler
R channel.

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

`tasks` carries `app_id` (nullable) and `tm_endpoint_address` (not
null). The `app_id IS NULL` discriminator drives the "is this
app-bound?" behavior across `AppHost.runMessageAuthorize`,
`conversation.service` authority checks, and the dispatch admission
path.

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
  Default-TM (UUID-bound `DEFAULT_DM_TM_ADDRESS` /
  `DEFAULT_GROUP_TM_ADDRESS`) for ordinary DMs/groups; app-bound
  `tm:app:<uuid>` for app-moderated tasks. The `tm_endpoint_address`
  column on `tasks` is the routing key.
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
