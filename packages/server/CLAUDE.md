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
│   ├── capability-middlewares.ts # per-cap CapabilityMiddleware (provides/derivePayload/obtain) (#705 HALF-2)
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


## R-channel capabilities (cap-as-middleware, #705 HALF-2)

Privileged service methods declare their preconditions in their type
signature via Effect's R channel. Each per-frame capability is a
`CapabilityMiddleware` declared at the SERVER binding site — NOT descriptor
metadata. A method's binding carries a `middlewares` tuple; the binding's
`weaveCaps` weaves a STATIC, hand-expanded `provideServiceEffect` chain (one
concrete-tag step per cap) over the handler. There is no descriptor
`capabilities` array, no `argsOf` resolver, no runtime `dischargeCaps` fold,
and no positional `CapProviders` tuple — all deleted in HALF-2. The wire
descriptor (`defineRpc`) carries ONLY the params/result shape.

```ts
// server/src/app/capability-middlewares.ts — one CapabilityMiddleware per cap
export const messageSendPermissionMiddleware: CapabilityMiddleware<
  MessagesSendParams, typeof MessageSendPermission, /* Input */, /* Env */, /* Fail */
> = {
  provides: MessageSendPermission,            // the Context.Tag the handler yields
  derivePayload: (params) => Effect.gen(function* () {
    // TYPED params (NOT unknown) + the caller via `yield* callerAgentId`
    // (CurrentPrincipal read — NO ctx param, NO narrowToDispatchContext).
    return { /* ... */, senderAgentId: yield* callerAgentId };
  }),
  obtain: obtainMessageSendPermission,        // typed input → service value (NO `args as Shape`)
};

// server/src/task/handlers/messages.handlers.ts — binding weaves the chain
defineTaskMiddlewareMethod(
  MessagesSend,
  [conversationInTaskForSend, messageSendPermissionMiddleware] as const, // totality anchor
  {
    callablePrincipal: "agent",
    requiresActive: true,
    handler: handleMessageSend,
    // REVERSE declaration order: FIRST-declared cap is the OUTERMOST step
    // (last in source) for Forbidden-before-state-probe.
    weaveCaps: (handlerEffect, params) =>
      handlerEffect.pipe(
        provideMiddleware(messageSendPermissionMiddleware, params),
        provideMiddleware(conversationInTaskForSend, params),
      ),
  },
);
```

The principal is read as a SERVICE: `CurrentPrincipal` (protocol-owned Tag)
is provided by the slot body from the #720-narrowed arm; `derivePayload`
reads it via `yield* callerAgentId`. Cap-LESS methods bind via
`defineNetworkMethod` / `defineTaskMethod` / `defineAppMethod` (no
`middlewares`, `weaveCaps` is identity). The lone unauth method
(`network/connect`) binds via `defineConnectMethod` (no principal,
`ConnectionTag` only).

The compile-time TOTALITY lockstep: the cap idents are PINNED from the
declared `middlewares` tuple via `MiddlewaresOf` (NOT inferred from the
handler R — a method whose handler does not itself yield the cap, like
`messages/list`, would pin `never` and go false-green). `weaveCaps`'s input
is WIDENED to require every declared cap, so dropping a `provideMiddleware`
step leaks the cap into the woven R and fails the bound. Canaries:
`transport/middleware-slot.types-check.ts` (M1/M2/M3).

Capability shapes:

- **Obtain** — queries the DB, produces the capability value + payload row.
  `obtainXxx(input)` returns `Effect<Xxx["Type"], ServiceError, ServiceTag>`;
  the middleware's `derivePayload` builds `input` from typed params + the
  principal.
- **Refine** — validates an already-fetched row (no DB read).
  `refineXxx(row)` returns `Effect<Xxx["Type"], ValidationError>`. The
  refine helpers (`refineTaskActive`, `refineConversationNotArchived`)
  live in `@moltzap/protocol/task/capabilities`.
- **Composite** — collapses an intersection-with-alternative authorization
  set into one tag whose value is a discriminated union, because Effect's R
  channel cannot express "exactly one of N alternative tags must be
  provided" (architect Decision A, #606). `MessageSendPermission` is the
  canonical composite.

App-arm RPCs (D #705 R3/R7) gate app-ownership in the handler body, NOT via
a capability: each loads the task and calls
`assertAppOwnsTask(appConn.auth.appId, task)` directly. The four
`task/conversation/*` admin RPCs ALSO weave `ConversationInTask`;
`ConversationCreateAuthorization` is hand-piped via
`Effect.provideServiceEffect` at its handler call sites (a clean typed
obtain, not a middleware).

When you add a new capability: the tag class + value type live in
`packages/protocol/src/task/capabilities/<name>.ts` (so descriptors can
reference them without a layering violation). The obtain logic + the
`CapabilityMiddleware` live in `server/src/app/capability-middlewares.ts`
(inline for a simple obtain), or the obtain lives as a named function in
`server/src/task/services/<name>.ts` for a composite with its own direct
consumer (`obtainMessageSendPermission`,
`obtainConversationCreateAuthorization`). The binding adds the middleware to
its `middlewares` tuple AND a matching `provideMiddleware` step in
`weaveCaps`.

## Layered RPC method wrappers

`src/transport/define-layered-method.ts` exports the cap-LESS wrappers
`defineNetworkMethod` / `defineTaskMethod` / `defineAppMethod`, the
cap-BEARING wrappers `defineTaskMiddlewareMethod` / `defineAppMiddlewareMethod`
(network has no cap-bearing method, so its variant is internal), and
`defineConnectMethod` for the lone unauth `network/connect`. Every wrapper
bottoms out at `makeMiddlewareSlot` (the SINGLE slot mechanism, #705 HALF-2 —
`makeErasedSlot` + `dischargeCaps` are gone). Each enforces a per-layer Tag
allowlist (`NetworkTags` ⊂ `TaskTags` ⊂ `AppTags`) so a handler at layer L
cannot pull a service that only layer L+1 owns. See `transport/README.md` for
the layer hierarchy and `transport/layer-tags.ts` for the allowlists.

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
  `AppConnection`) held in a `Ref<HashMap<ConnId, Connection>>`. The
  legacy single-shape `MoltZapConnection` map was deleted at D #705
  CP4f. Sanctioned mutators: `addUnauthenticated`, `authenticate`,
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
- **R-channel capability** — Nominal `Context.Tag` whose value
  carries the runtime IDs + already-fetched payload row that a
  `require*` authority check would otherwise fetch inline. Discharged
  per-frame by a `CapabilityMiddleware` (provides / derivePayload /
  obtain) woven at the binding site (#705 HALF-2). Pattern documented in
  `src/app/capability-middlewares.ts` (file-level JSDoc).
