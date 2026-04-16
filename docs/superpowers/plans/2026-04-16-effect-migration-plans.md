# Effect Migration Plans

> **For agentic workers:** This document is a planning artifact, not an implementation diff. Follow one track or combine compatible tracks, but do not create a long-lived dual architecture. Temporary compatibility wrappers are allowed only at package boundaries.

**Goal:** Port the client and server runtimes to Effect for stronger type safety, explicit dependency wiring, typed failures, and safer long-lived state management, while keeping `@moltzap/protocol` as the canonical TypeBox/AJV wire contract.

**Repository decisions already locked in:**
- `@moltzap/protocol` stays TypeBox-first for now.
- `packages/server/` is the canonical source path for `@moltzap/server-core`.
- The end state must not keep both imperative and Effect runtime trees in parallel.
- `@effect/vitest` is part of the migration foundation, not late cleanup.
- `packages/app-sdk` is not in the current branch; that track applies when PR #72 or equivalent lands.

**Current hotspots in this checkout:**
- `packages/server/src`: about 220 `as` casts, 40 `throw new RpcError` sites, 6 `JSON.parse` sites.
- `packages/client/src`: about 176 `as` casts, 5 `JSON.parse` sites.
- Mutable state clusters are concentrated in:
  - `packages/server/src/app/app-host.ts`
  - `packages/server/src/ws/connection.ts`
  - `packages/server/src/services/conversation.service.ts`
  - `packages/client/src/service.ts`
  - `packages/client/src/ws-client.ts`
- The most important unsafe seam today is `packages/server/src/rpc/context.ts`, where `defineMethod<T>()` erases types with a cast and relies on runtime validators to save the contract later.

**Companion deep-dive:** See `docs/superpowers/plans/2026-04-16-effect-hard-parts.md` for the code-level traps, behavior bugs worth fixing during migration, and recommended Effect patterns for the hardest runtime seams.

---

## Shared Constraints

### Hard rules

- [ ] Keep `@moltzap/protocol` neutral and publishable without Effect.
- [ ] Do not introduce a permanent `src/effect/` shadow tree beside the existing runtime tree.
- [ ] Preserve current package names and public entrypoints unless a separate package-identity change is approved.
- [ ] Use Effect internally even if a temporary Promise API is preserved externally.
- [ ] Migrate in vertical slices and delete replaced imperative code as each slice stabilizes.

### Target runtime model

- Boundary validation:
  - TypeBox + AJV stays at the transport edge.
  - Invalid wire data becomes typed Effect failures immediately after validation.
- Service model:
  - `Context.Tag` for service identities.
  - `Layer` for construction and dependency graphs.
  - `Effect` return types instead of `Promise + throw`.
- Error model:
  - Preserve protocol `ErrorCodes`.
  - Replace thrown operational errors with tagged Effect error values.
  - Convert Effect failures back to protocol frames only at the edge.
- Stateful runtime:
  - `Ref` / `SynchronizedRef` for mutable state.
  - `Deferred` for pending RPC results and readiness gates.
  - `Queue` and optionally `Stream` for inbound event pipelines.
  - `Scope` for socket, timer, and server lifecycle.
  - `Schedule` for reconnect and retry policies.

### Migration policy

- [ ] Each migrated module keeps the same responsibility as the current module.
- [ ] Compatibility wrappers may exist at package boundaries only.
- [ ] New migrated tests use `@effect/vitest`.
- [ ] Existing non-Effect tests may remain until the touched area is fully migrated.
- [ ] Strengthen TypeScript flags only when the migrated slice is ready to absorb them.

---

## Plan A: Core Runtime Migration

**Scope:** `@moltzap/server-core` and `@moltzap/client` become Effect-native internally, while `@moltzap/protocol`, Hono, WebSocket transport wiring, and Kysely remain in place initially.

**Outcome:** One canonical Effect runtime model without a framework rewrite at the edge.

### Stage A0: Foundation And Guardrails

**Files likely touched:**
- `package.json`
- `packages/server/package.json`
- `packages/client/package.json`
- `tsconfig.base.json`
- `packages/server/vitest*.config.*`
- `packages/client/vitest*.config.*`

- [ ] Add foundational dependencies where needed:
  - `effect`
  - `@effect/platform`
  - `@effect/platform-node`
  - `@effect/vitest`
- [ ] Decide whether to add a small shared internal runtime package or keep helpers local to `packages/server/src/runtime` and `packages/client/src/runtime`.
- [ ] Add minimal Effect test harness examples in both `server` and `client`.
- [ ] Tighten TypeScript in stages:
  - stage 1: `useUnknownInCatchVariables`
  - stage 2: `noImplicitOverride`
  - stage 3: `exactOptionalPropertyTypes`
- [ ] Document migration invariants in package READMEs or internal docs if needed.

**Deliverables:**
- New baseline dependencies.
- A small set of Effect helpers for:
  - tagged errors
  - logging helpers
  - Promise bridge helpers
  - validator-to-Effect bridge helpers

**Verification:**
- `pnpm --filter @moltzap/server-core test`
- `pnpm --filter @moltzap/client test`
- At least one `@effect/vitest` test per package to prove runtime setup works.

### Stage A1: Protocol Boundary Bridge

**Files likely touched:**
- `packages/server/src/rpc/context.ts`
- `packages/server/src/rpc/router.ts`
- `packages/client/src/ws-client.ts`
- `packages/client/src/service.ts`
- New local bridge modules in `packages/server/src/rpc/` and `packages/client/src/runtime/`

- [ ] Add a boundary helper that turns an AJV validator into `Effect.Effect<T, InvalidParamsError>`.
- [ ] Replace the cast-based `defineMethod<T>()` pattern with a typed method definition that keeps:
  - validator
  - typed params
  - typed result
  - typed failure channel
- [ ] Normalize wire decode/encode logic so `JSON.parse`, validator failures, and protocol-frame mismatches are all surfaced as explicit typed errors.
- [ ] Stop passing `unknown` into deep handler/service code once validation has already succeeded.

**Target module shape:**

```ts
type RpcProgram<P, A, E, R> = (params: P, ctx: AuthenticatedContext) => Effect.Effect<A, E, R>

interface RpcMethod<P, A, E, R> {
  readonly validator: (input: unknown) => boolean
  readonly run: RpcProgram<P, A, E, R>
  readonly requiresActive?: boolean
}
```

**Deliverables:**
- A reusable validator bridge.
- A typed RPC definition model.
- Router error translation from Effect failures to `ResponseFrame.error`.

**Verification:**
- Rewrite `packages/server/src/rpc/router.test.ts` to cover:
  - validation failure
  - typed domain failure
  - unexpected defect
  - active-agent gating

### Stage A2: Server Composition Skeleton

**Files likely touched:**
- `packages/server/src/app/server.ts`
- `packages/server/src/app/types.ts`
- `packages/server/src/logger.ts`
- `packages/server/src/config/*`
- `packages/server/src/db/client.ts`
- New modules under `packages/server/src/runtime/`

- [ ] Define server service tags for:
  - config
  - logger
  - db
  - connection registry
  - broadcaster
  - auth service
  - conversation service
  - message service
  - delivery service
  - presence service
  - participant service
  - app host
- [ ] Replace constructor-assembled service graphs in `createCoreApp()` with Layers.
- [ ] Keep Hono as the transport shell for now, but have handlers execute Effects.
- [ ] Move config loading from throw-based functions toward Effect-native loading and validation.
- [ ] Wrap Kysely and Node APIs with `Effect.tryPromise` or `Effect.sync` at the boundary.

**Important boundary rule:**
- Hono handlers may remain `async`, but they should only bridge into `Effect.runPromise` at the outermost edge.

**Deliverables:**
- A single composed server Layer tree.
- A `runServerEffect()` helper for HTTP and WS edges.
- Clear separation between environment construction and business logic.

**Verification:**
- Server smoke tests still pass.
- Server integration helper can still boot the app with the new Layer-backed construction.

### Stage A3: Server Vertical Slice 1 — Auth And Session Handshake

**Files likely touched:**
- `packages/server/src/app/handlers/auth.handlers.ts`
- `packages/server/src/services/auth.service.ts`
- `packages/server/src/app/server.ts`
- `packages/server/src/rpc/context.ts`
- `packages/server/src/ws/connection.ts`

- [ ] Convert `auth/connect` to `Effect`.
- [ ] Convert agent registration HTTP flow to `Effect`.
- [ ] Replace thrown `RpcError` usage in the auth path with tagged errors.
- [ ] Move connection authentication state writes behind a service interface.
- [ ] Make `buildHelloOk()` an Effect program rather than a side-effecting helper.

**Goals of this slice:**
- Prove the router can execute typed programs.
- Prove Hono HTTP and WS edges can run the same Effect-based services.
- Prove connection state can be modeled without leaking mutation everywhere.

**Verification:**
- Registration integration test.
- Authentication failure integration test.
- Heartbeat / reconnect baseline still works.

### Stage A4: Server Vertical Slice 2 — Conversations And Messages

**Files likely touched:**
- `packages/server/src/app/handlers/messages.handlers.ts`
- `packages/server/src/app/handlers/conversations.handlers.ts`
- `packages/server/src/services/conversation.service.ts`
- `packages/server/src/services/message.service.ts`
- `packages/server/src/services/delivery.service.ts`
- `packages/server/src/ws/broadcaster.ts`

- [ ] Convert conversation and message services to `Effect`.
- [ ] Replace throw-based authorization and existence checks with typed failures.
- [ ] Move preview cache and similar local mutable caches into `Ref`s or scoped service state.
- [ ] Convert broadcast and delivery tracking to Effects, even if the underlying socket/db calls remain imperative internally for one stage.
- [ ] Make `messages/send` and `messages/list` fully typed from validated params to typed result.

**Why this slice matters:**
- This is the highest-value path in the system.
- It exercises DB, transport, domain validation, encryption, and event fanout in one place.

**Verification:**
- Messaging integration tests:
  - DM flow
  - group chat
  - message history
  - multipart
  - concurrent messages
  - archived conversation rejection

### Stage A5: Server Vertical Slice 3 — Presence, Permissions, And AppHost

**Files likely touched:**
- `packages/server/src/app/app-host.ts`
- `packages/server/src/app/handlers/apps.handlers.ts`
- `packages/server/src/app/handlers/presence.handlers.ts`
- `packages/server/src/services/presence.service.ts`
- `packages/server/src/services/participant.service.ts`

- [ ] Convert `AppHost` from a class with many `Map`s and timers into Effect-managed state and scoped resources.
- [ ] Replace inflight permission and challenge tracking with `Ref` + `Deferred`.
- [ ] Replace timeout handling with `Effect.timeout` / `Schedule`.
- [ ] Convert presence and participant flows to typed programs.
- [ ] Move session admission flow, hook execution, and close flow into explicit Effect programs.

**Key note:**
- `AppHost` is the most stateful server module and the closest preview of what `app-sdk` will need on the client side. This slice should set the runtime pattern rather than invent a one-off style.

**Verification:**
- Integration coverage for:
  - permissions
  - app hooks
  - session close
  - session failure

### Stage A6: Client Runtime Skeleton

**Files likely touched:**
- `packages/client/src/ws-client.ts`
- `packages/client/src/service.ts`
- `packages/client/src/channel-core.ts`
- New local modules under `packages/client/src/runtime/`

- [ ] Replace the websocket client lifecycle with `Effect`, `Scope`, `Deferred`, `Queue`, `Ref`, and `Schedule`.
- [ ] Model pending RPCs as typed deferred results rather than ad hoc `Map<string, { resolve, reject }>` state.
- [ ] Move reconnect/backoff out of `setTimeout` recursion into a declarative retry policy.
- [ ] Decode and classify inbound frames before they reach service logic.
- [ ] Replace mutable event dispatch chains with an explicit queue-driven pipeline.

**Concrete mapping from current implementation to Effect primitives:**
- `pendingRequests` -> `Ref<HashMap<RequestId, Deferred<Response>>>`
- `reconnectAttempt` + `setTimeout` -> `Schedule.exponential(...)`
- `onDisconnect` / `onReconnect` callbacks -> pub/sub queue or managed subscriptions
- raw websocket resource -> `Scope`

**Verification:**
- `packages/client/src/service.test.ts`
- `packages/client/src/channel-core.test.ts`
- `packages/client/src/__tests__/service.integration.test.ts`

### Stage A7: Client Service And CLI Stabilization

**Files likely touched:**
- `packages/client/src/service.ts`
- `packages/client/src/cli/socket-client.ts`
- `packages/client/src/cli/http-client.ts`
- `packages/client/src/cli/commands/*`
- `packages/client/src/index.ts`

- [ ] Keep the public client API Promise-compatible initially via `Effect.runPromise`.
- [ ] Remove direct internal mutation wherever message caches, conversation caches, and name-resolution caches can become `Ref` state.
- [ ] Decide whether the local socket server remains imperative or also becomes scoped Effect-managed I/O.
- [ ] Ensure CLI callers do not need to know that internals migrated to Effect.
- [ ] Expose typed service-level errors instead of generic `Error("RPC timeout: ...")`.

**Deliverables:**
- Stable external API.
- Effect-native internals.
- Cleaner failure surface for SDK and CLI consumers.

**Verification:**
- CLI command tests.
- Existing integration flows that use `@moltzap/client`.

### Stage A8: Test Infrastructure Migration

**Files likely touched:**
- `packages/server/src/__tests__/*`
- `packages/client/src/__tests__/*`
- `packages/server/src/test-utils/*`
- `packages/client/src/test-utils/*`
- `vitest` config files

- [ ] Move migrated slices to `@effect/vitest`.
- [ ] Introduce test Layers for:
  - fake logger
  - fake clock where useful
  - fake or in-memory connection registries
  - DB fixtures
- [ ] Keep existing integration testcontainers flow, but bridge setup into Effect where it improves determinism.
- [ ] Use `TestClock` where timeout-heavy logic is migrated.

**Deliverables:**
- Deterministic timeout and retry tests.
- Lower reliance on real timers for client reconnect and app permission flows.

### Stage A9: Hardening And Cleanup

**Files likely touched:**
- Entire migrated surface
- `tsconfig.base.json`
- Any package-specific tsconfig files

- [ ] Turn on the next TypeScript strictness flags once migrated slices are ready.
- [ ] Remove compatibility wrappers that only existed for migration.
- [ ] Delete replaced imperative code paths.
- [ ] Reduce remaining `as` casts to exceptional edge cases only.
- [ ] Audit `JSON.parse` sites and centralize them behind safe decoders.

**Exit criteria for Plan A:**
- `server` and `client` runtimes are Effect-native internally.
- No parallel old/new service trees remain.
- Public protocol package remains TypeBox-based.
- Public APIs are stable.

---

## Plan B: HTTP Transport Replacement

**Scope:** Replace Hono for HTTP endpoints with `@effect/platform` / `@effect/platform-node`, while preserving the already-migrated domain/runtime layers from Plan A.

**Important:** This plan is optional and should not be started before the core runtime migration is coherent. Rewriting the HTTP shell first would hide the real migration work behind framework churn.

### Stage B0: Preconditions

- [ ] Plan A Stage A2 is complete.
- [ ] Domain services are already available as Layers.
- [ ] HTTP edge handlers are already thin bridges into Effects.

### Stage B1: Replace Simple HTTP Routes

**Files likely touched:**
- `packages/server/src/app/server.ts`
- `packages/server/src/standalone.ts`
- `packages/server/src/app/dev.ts`
- New modules under `packages/server/src/http/`

- [ ] Reimplement `/health` using `HttpRouter` or `HttpApi`.
- [ ] Reimplement `/api/v1/auth/register` on top of the same Effect service used by the current Hono route.
- [ ] Reimplement `/api/v1/permissions/resolve` only after the underlying permission flow is already Effect-native.

**Verification:**
- Existing HTTP-level tests and integration flows still pass.

### Stage B2: Decide WebSocket Strategy

**There are two viable subplans:**

#### B2a: Keep current WebSocket edge, replace only HTTP

- [ ] Keep Hono or raw `ws` only for `/ws`.
- [ ] Run the already-migrated Effect domain inside that thin edge.

#### B2b: Replace WebSocket edge with Effect Platform primitives

- [ ] Evaluate `Socket` / `NodeSocket` for server-side websocket support.
- [ ] Design a dedicated Effect-based WS session runtime rather than forcing the HTTP abstraction to own it.
- [ ] Replace connection lifecycle, heartbeat handling, and frame dispatch at the transport edge.

**Risks of B2b:**
- Higher engineering cost than simple HTTP replacement.
- Harder parity testing for current WS behavior.
- Easy to over-couple transport and domain if the runtime boundaries are not already clean.

### Stage B3: Remove Hono

- [ ] Only remove Hono after all live routes are migrated and parity tested.
- [ ] Keep any remaining dev-only helpers or middleware isolated until the last route leaves Hono.

**Exit criteria for Plan B:**
- No Hono dependency in the server runtime.
- HTTP routes are served through Effect Platform.
- WS strategy is explicit, not incidental.

---

## Plan C: Database Strategy Plans

This area is intentionally split into alternatives. The repo can stop after Plan A and still be fully Effect-native at the service/runtime layer.

**Current recommendation for this repo:** Treat **Plan C1** as the default migration path.
- Keep Kysely for the first Effect migration wave.
- Hide it behind an Effect `DbService` / Layer boundary.
- Revisit `@effect/sql-kysely` only after a proof-of-concept on real query-heavy modules.
- Treat a full move to `@effect/sql-pg` as a separate project, not part of the initial runtime migration.

**Why this is the current recommendation:**
- The server currently has roughly 100 query-builder call sites plus raw `sql`` fragments, with the densest concentration in:
  - `packages/server/src/app/app-host.ts`
  - `packages/server/src/services/conversation.service.ts`
  - `packages/server/src/services/message.service.ts`
- The current DB bootstrap in `packages/server/src/db/client.ts` is already centralized, which makes it straightforward to wrap with `Layer.scoped`.
- Rewriting the runtime model and rewriting the SQL layer at the same time would create avoidable migration risk.

### Plan C1: Keep Kysely Behind Effect Services

**Scope:** No SQL framework rewrite. Keep Kysely as the query builder and database integration surface, but expose it only through Effect services.

**When this plan is enough:**
- Type safety goals are mainly about runtime control flow, state, and errors.
- Existing Kysely queries are stable and readable.
- The team wants the lowest-risk migration.

**Stages:**
- [ ] Wrap DB access behind a `DbService` tag.
- [ ] Move DB construction and teardown into `Layer.scoped` using the existing `createDb()` / `db.destroy()` lifecycle.
- [ ] Centralize transaction helpers as Effect combinators.
- [ ] Remove direct Kysely construction from leaf services.
- [ ] Ensure all DB interaction returns typed Effect failures, not thrown driver errors.

**Exit criteria:**
- Business logic is Effect-native.
- Kysely remains an implementation detail.

### Plan C2: Use `@effect/sql-kysely` As A Bridge

**Scope:** Introduce the official bridge package if it materially improves Effect integration without rewriting SQL access patterns.

**Prerequisite:** Prototype it against the real query shapes in:
- `packages/server/src/services/conversation.service.ts`
- `packages/server/src/services/message.service.ts`
- `packages/server/src/app/app-host.ts`

**Important caveats verified against the current package:**
- The package README explicitly says the integration is **not fully future-proof** because it depends on Kysely internals and builder patching.
- The current npm package peer dependency requires `kysely ^0.28.2`.
- This repo currently uses `kysely ^0.27.0` in `packages/server` and `packages/evals`.
- A scratch install validated the current state:
  - latest `@effect/sql-kysely` installs and typechecks cleanly with `kysely 0.28.x`
  - latest `@effect/sql-kysely` does **not** install cleanly with `kysely 0.27.x`
  - forcing the `0.27.x` install still failed typechecking in a minimal sample

**Interpretation:**
- Plan C2 is not a same-day enhancement on top of the current repo.
- It first requires a deliberate Kysely upgrade track.
- Even after the upgrade, it should still be treated as a bridge with patch-based risk, not a zero-risk foundation.

**Stages:**
- [ ] Upgrade Kysely to a version supported by the current `@effect/sql-kysely` release in a separate compatibility PR.
- [ ] Run a proof-of-concept on one service with joins, transactions, and returning clauses.
- [ ] Evaluate type quality, transaction ergonomics, and operational complexity.
- [ ] If satisfactory, roll it out service by service.

**Reason this is separate:**
- The published docs surface for `@effect/sql-kysely` is smaller than the core SQL packages.
- This should be validated on real queries before it becomes architectural policy.

### Plan C3: Full SQL Rewrite To `@effect/sql-pg`

**Scope:** Replace Kysely with Effect SQL primitives and Postgres integration.

**When this plan makes sense:**
- The team wants a fully Effect-native DB abstraction.
- Query composition, resolvers, and transaction policies should live inside the Effect ecosystem.
- Rewriting query builders is acceptable cost.

### Stage C3.0: DB Capability Audit

- [ ] Inventory every Kysely usage pattern:
  - joins
  - returning clauses
  - `sql`` fragments
  - transactions
  - pagination
  - generated database types
- [ ] Identify which queries map cleanly to `SqlClient`, `Statement`, and `SqlResolver`.

### Stage C3.1: Infrastructure Replacement

**Files likely touched:**
- `packages/server/src/db/client.ts`
- `packages/server/src/db/database.ts`
- `packages/server/src/services/*`

- [ ] Replace pool setup with `PgClient.layer` or equivalent Layer construction.
- [ ] Rework transaction entrypoints to `SqlClient.withTransaction`.
- [ ] Replace direct driver error exposure with tagged DB failures.

### Stage C3.2: Query Rewrite By Vertical Slice

- [ ] Rewrite auth service queries.
- [ ] Rewrite conversation service queries.
- [ ] Rewrite message and delivery queries.
- [ ] Rewrite app host permission/session queries last.

### Stage C3.3: Remove Kysely

- [ ] Delete Kysely-specific types, codegen config, and dialect setup only after all query paths are migrated.

**Exit criteria for Plan C3:**
- No Kysely dependency remains.
- SQL access is fully Effect-native.

---

## Plan D: App SDK Migration Plan

**Scope:** Applies when `packages/app-sdk` exists in the branch. Build it on top of the Effect-native client runtime rather than directly on the current imperative websocket client.

**Why this is its own plan:**
- `app-sdk` is public API surface.
- Its internal runtime wants Effect, but its external surface should not force downstream apps to adopt Effect.

### Stage D0: Preconditions

- [ ] Plan A Stage A6 is complete.
- [ ] Client reconnect, pending RPC, and event dispatch are already Effect-native.

### Stage D1: Internal Runtime Model

**Likely modules when the package exists:**
- `packages/app-sdk/src/app.ts`
- session managers
- heartbeat managers
- callback registries

- [ ] Replace session maps and reverse indexes with `Ref`.
- [ ] Replace heartbeat `setInterval` logic with `Schedule`.
- [ ] Replace readiness and challenge waits with `Deferred`.
- [ ] Replace callback-driven inbound routing with `Queue` or managed subscriptions.

### Stage D2: Public API Compatibility

- [ ] Keep public Promise/callback APIs stable.
- [ ] Hide Effect internals behind small wrapper methods.
- [ ] Expose typed errors and structured events without requiring downstream code to know `Effect`.

### Stage D3: Integration With Server AppHost Semantics

- [ ] Align SDK session lifecycle with the server’s Effect-based `AppHost`.
- [ ] Share vocabulary and failure semantics for:
  - permission requests
  - session close
  - ping / heartbeat
  - hook-driven flows

**Exit criteria for Plan D:**
- `app-sdk` is built on the canonical Effect client runtime.
- No second client runtime emerges inside the SDK.

---

## Suggested PR Slicing Template

This section is neutral about which plan to choose. It exists to keep any chosen plan shippable.

### Small PR policy

- [ ] One vertical slice per PR wherever possible.
- [ ] Keep compatibility wrappers local and delete them quickly.
- [ ] Do not mix runtime migration with framework replacement in the same PR.
- [ ] Prefer tests in the same PR as the migrated slice.

### Example PR sequence for Plan A

1. Foundation dependencies, helpers, and `@effect/vitest` setup.
2. RPC/validator bridge and typed router scaffolding.
3. Server composition Layer skeleton without changing behavior.
4. Auth/register/connect slice.
5. Conversations/messages slice.
6. Presence/app-host slice.
7. Client WS runtime slice.
8. Client service/channel-core slice.
9. CLI stabilization and cleanup.
10. Strictness hardening.

### Example PR sequence for Plan B

1. HTTP abstraction skeleton beside current Hono routes.
2. `/health` and registration route parity.
3. Permission callback parity.
4. Hono removal.

### Example PR sequence for Plan C3

1. SQL infrastructure Layer setup.
2. Auth queries.
3. Conversation queries.
4. Message and delivery queries.
5. App host queries.
6. Kysely removal.

---

## Definition Of Done

- [ ] `@moltzap/protocol` is still the neutral client/server contract package.
- [ ] `@moltzap/server-core` and `@moltzap/client` are Effect-native internally.
- [ ] No permanent dual runtime architecture exists.
- [ ] Timeout, retry, and long-lived session flows are no longer hand-rolled around raw timers and mutable maps.
- [ ] Typed failures replace exception-heavy control flow in migrated slices.
- [ ] `@effect/vitest` is used for migrated test areas.

---

## Reference Material

- Effect docs index: `https://effect-ts.github.io/effect/`
- `Effect`: `https://effect-ts.github.io/effect/effect/Effect.ts.html`
- `Layer`: `https://effect-ts.github.io/effect/effect/Layer.ts.html`
- `Context`: `https://effect-ts.github.io/effect/effect/Context.ts.html`
- `Config`: `https://effect-ts.github.io/effect/effect/Config.ts.html`
- `Data`: `https://effect-ts.github.io/effect/effect/Data.ts.html`
- `@effect/vitest`: `https://effect-ts.github.io/effect/docs/vitest`
- `@effect/platform`: `https://effect-ts.github.io/effect/docs/platform`
- `@effect/platform-node`: `https://effect-ts.github.io/effect/docs/platform-node`
- `@effect/sql`: `https://effect-ts.github.io/effect/docs/sql`
- `@effect/sql-pg`: `https://effect-ts.github.io/effect/docs/sql-pg`
- `@effect/sql-kysely`: `https://effect-ts.github.io/effect/docs/sql-kysely`
