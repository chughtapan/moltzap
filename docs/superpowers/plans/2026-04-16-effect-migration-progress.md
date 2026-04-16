# Effect Migration — Progress Log

> **For downstream consumers.** This document tracks scope expansion and completion state for the Effect migration. Planning artifacts live in `2026-04-16-effect-migration-plans.md` (scope), `2026-04-16-effect-hard-parts.md` (constraints + mandatory fixes), and `2026-04-16-effect-kysely-poc.md` (SQL bridge reference).

**Branch doing the work:** `worktree-bold-elm-c01i` (will land as a series of PRs as scopes converge).

**Last updated:** 2026-04-16, mid-session — 7 parallel agents still running.

---

## What shipped (landed in the working tree, typecheck-clean, tests green)

### Plan A — Core runtime migration

- **A0** — Foundation deps + `runtime/` helpers. `effect`, `@effect/vitest` installed in `@moltzap/server-core` and `@moltzap/client`. Tagged errors (`RpcFailure`, `InvalidParamsError`, `ForbiddenError` server; `NotConnectedError`, `RpcTimeoutError`, `RpcServerError`, `MalformedFrameError` client). Validator bridge (`validateParams(v, input): Effect<T, InvalidParamsError>`). Example `@effect/vitest` tests per package.

- **A1 + A3 + A4 + A5** — Full server Effect migration. **No throws of typed domain errors anywhere.** `defineMethod` now only accepts `Effect<T, RpcFailure>` handlers. Router classifies three failure classes distinctly (decode / typed domain / defect) and maps to wire `ResponseFrame.error`. Every service (`auth`, `participant`, `conversation`, `delivery`, `message`, `user`) is Effect-returning. AppHost public methods return Effects. `DefaultPermissionService` uses `Effect.async` with typed `PermissionDeniedError | PermissionTimeoutError` channels. `inflightPermissions` coalesces via `Deferred` instead of `Promise<string[]>`. `admitAgentsAsync` uses `Effect.forkDaemon`. `runHookWithTimeout` uses `Effect.timeout` + `Effect.catchTag("TimeoutException", ...)`. `Promise.allSettled` in admission → `Effect.all([...], { concurrency: "unbounded", mode: "either" })`. `ContactService.areInContact: Effect<boolean, never>`. All `RpcError` class uses gone. 70/70 unit + 79/79 integration tests pass.

- **A6** — Client WS runtime Effect-native. `ws-client.ts` internals are `ManagedRuntime` + `Ref<HashMap<string, Deferred>>` + `Effect.timeout` + scope-managed socket. New `packages/client/src/runtime/frame.ts` decodes inbound frames via protocol's pre-compiled AJV validators. **§5 hard-parts behavioral fixes (all four):**
  1. `connect()` no longer hangs on pre-open close/error — settles immediately via single-shot latch.
  2. Pending RPCs fail fast with `NotConnectedError` on disconnect (previously waited 30s for timeout).
  3. Automatic retry for non-idempotent RPCs **removed**. Silent retry of `messages/send` / `conversations/create` / `apps/create` was a correctness bug; now every method gets one attempt.
  4. Central typed decode for inbound frames via `decodeFrame` — malformed frames logged and dropped, never resolve a pending Deferred.

- **A7** — Client `MoltZapService` Ref migration + **protocol contract drift bug fix** (§6.1). `sendToAgent` was calling `agents/lookupByName` with `{ name }` but protocol requires `{ names: string[] }`; return shape was `{ agent: { id } }` but protocol returns `{ agents: AgentCard[] }`. Tests reinforced the bug. Both fixed. All 7 stateful Maps moved to `Ref<HashMap>` (conversations, messages, agentNames, agentConversationCache, lastNotified, lastRead, pendingNameLookups). `pendingNameLookups` uses `Deferred` for coalescing (matches server's `inflightPermissions` pattern). Ext public API unchanged: async methods stay async, sync getters stay sync via `Effect.runSync(Ref.get(...))`. 128/128 client tests pass.

### Plan B — HTTP transport replacement

- **Hono → `@effect/platform` / `@effect/platform-node`** landed. All HTTP routes (`/health`, `/api/v1/auth/register`, `/api/v1/permissions/resolve`) served via `HttpRouter` + `HttpMiddleware.cors`. WebSocket kept on `ws` package (POC-guided decision — `@effect/platform` WS is higher-risk per hard-parts §5). WS upgrade attached manually to the Node `http.Server` exposed from `NodeHttpServer.layerContext`. Zero `hono` imports remain in `packages/server/src`. 149/149 tests pass.

### Layer wiring + dependency injection

- **Task #6 A2** — Layer-based `createCoreApp` wiring. 13 `Context.Tag`s (Db, Logger, Encryption, ConnectionManager, Broadcaster, Auth/Participant/Conversation/Delivery/Presence/AppHost/DefaultPermission/MessageService). 5-tier Layer composition via `Layer.provideMerge`. Handler factories' `deps` API unchanged — `createCoreApp` destructures a `ResolvedServices` object from a single `Effect.runSync(resolveServices.pipe(Effect.provide(FullLive)))`. 90-line imperative constructor chain → ~25 lines of declarative wiring. `packages/server/src/app/layers.ts` holds all tag + layer definitions.

### Config

- **Task #8** — `Effect.Config` native config loader. `packages/server/src/config/effect-config.ts` defines the full YAML shape via `Config.all` / `Config.nested` / `Config.option`. `loadConfigFromFile(path)` now returns `Effect<MoltZapConfig, ConfigLoadError>`. `ConfigLoadError` is a `Data.TaggedError` with discriminated `kind: "read" | "yaml" | "env" | "validation"`. `${ENV_VAR}` interpolation preserved. Behavior-compatible for consumers — `standalone.ts` edit is 3 lines.

### Docs

- Migration plans, hard-parts guide, SQL-Kysely POC doc all in `docs/superpowers/plans/` (this PR).

---

## What's in flight (agents still running)

These are being worked on in parallel. Each touches a disjoint file scope.

| Scope | Status | Files |
|---|---|---|
| **C2 Kysely** — custom PGlite SqlClient so `@effect/sql-kysely/Pg` works against both pg and PGlite (maintains zero-Docker quickstart) | Agent running | `packages/server/src/db/pglite-sql-client.ts` (new), `db/client.ts`, `db/effect-kysely-toolkit.ts` |
| **Task #13 Typed RPC manifest** — `defineRpc({ name, params, result })` factory in `@moltzap/protocol`; typed `sendRpc<M>` + `defineMethod(manifest, handler)` overloads on client/server. Would have caught the A7 `sendToAgent` drift at compile time | Agent running | `packages/protocol/src/rpc.ts` (new), `rpc-registry.ts` (new), every method file under `schema/methods/*.ts`, client `ws-client.ts` + server `rpc/context.ts` overloads, one handler as POC |
| **Evals Effect migration** — 4-phase pipeline (`runner.ts`) via `Effect.forEach { concurrency }`; LLM-judge retry+timeout via `Schedule.exponential().jittered` + `Effect.retry`; container lifecycle via `Effect.acquireRelease`; `FiberMap` for agent fleet | Agent running | `packages/evals/src/e2e-infra/*.ts` |
| **OpenClaw polish** — module-global `activeClients` Map → factory closure; `try/catch` ladders in `directory.listPeers` / `listGroups` / `deliver` → `Effect.catchAll`; `new Promise(r => abortSignal.addEventListener("abort", r))` → `Effect.async` | Agent running | `packages/openclaw-channel/src/openclaw-entry.ts` |
| **Task #7 FiberRef for connId** — hard-parts §4. Replace `AsyncLocalStorage<string>` with a `ConnIdTag` Context.Tag provided at WS edge. Removes `getConnId: () => ...` from every handler factory's deps | Agent running | `rpc/context.ts`, `rpc/router.ts`, `app/server.ts`, `app/handlers/*.ts` |
| **Task #9 Effect logging Layer** — replace Pino global + ctor-injected `logger: Logger` with Effect `Logger.make` backed by Pino. Services call `Effect.logInfo(...).pipe(Effect.annotateLogs({...}))` | Agent running | `logger.ts`, `services/*.ts`, `app-host.ts`, `layers.ts` |
| **Task #11 Layer-based test fakes** — replace `vi.mock` / `vi.spyOn` of our own services with `Layer.succeed(XxxTag, fake)` or structurally-typed test doubles. Catches contract drift at compile time | Agent running | `adapters/webhook.test.ts`, `service.test.ts` (client), new `test-utils/fakes.ts` |
| **Nanoclaw cosmetic polish** | ✅ Done (cosmetic, for consistency) | `nanoclaw-channel/src/channels/moltzap.ts` |

---

## What's queued (not yet started)

| Scope | Gate |
|---|---|
| **Task #10 TestClock for timeout-heavy integration tests** — replace real `setTimeout` sleeps with `TestClock.adjust(Duration.seconds(N))`. Hot targets: `33-session-failure`, `30-permissions`, `30-app-hooks`, `31-session-close` | After pglite lands (integration suite must be green to verify the migration) |
| **Tighten `sloppy-code-guard.sh`** — reject `Promise<` / `async ` outside documented boundary files (transport edges, user-facing hook callbacks, framework contracts) | After everything else |
| **Test pyramid rebalance** (tracked as GitHub issue #77) — move ~50 integration tests to Layer-based unit tests. Expected 4x CI speedup | Separate follow-up; issue filed |

---

## Explicit non-goals for this migration

- **Do not** introduce a parallel `src/effect/` tree. Every migration slice replaces its imperative counterpart in-place.
- **Do not** force external consumers to adopt Effect. Client public API stays Promise-based. CoreApp public methods that are user-callbacks (`dbCleanup`, `ConnectionHook`, `AppHooks`) stay Promise-compatible — the contracts are imposed by downstream, not us.
- **Do not** migrate WebSocket transport to `@effect/platform`'s Socket. Hard-parts §5 flags it as higher-risk and incidental to this migration. Keep `ws` package; just Effect-manage the lifecycle.
- **Do not** drop PGlite. Zero-Docker quickstart is a product feature. The custom PGlite SqlClient (in flight) preserves it.

---

## Why this matters for downstream

- **Typed errors:** every RPC failure has a discriminated tag. Adding a new error code is a one-line `Data.TaggedError` declaration; the router pattern-matches on `_tag`. No more "InternalError" as a catch-all for silent data corruption.
- **Structured concurrency:** `Effect.forkDaemon` for background admission, `FiberMap` for fleet management (evals), `Scope`-managed WS sockets. No more orphaned Promises that outlive the request that started them.
- **Layer-based DI:** tests swap services for fakes with one line. The `sendToAgent` contract drift that shipped as a bug (fixed in A7) becomes a compile error with Layer-typed fakes.
- **Timer determinism:** with `TestClock` integration (queued), the 500ms-sleep patterns in integration tests disappear. CI speed + flake reduction.
- **Single source of truth for RPC contracts:** typed `defineRpc` manifest (in flight) unifies schema + types + validator + name per method. Enables future SDK codegen.

---

## Rough landing order (live; updated as agents converge)

1. Server migration (Plans A0–A5 + Plan B) — landed in working tree
2. Client migration (A6 + A7) — landed in working tree
3. Plan C2 (PGlite SqlClient) — in flight, gates integration test verification
4. Task #6 Layers + #8 Config + #13 RPC manifest + #7 FiberRef + #9 Logging Layer + #11 Test fakes — in flight
5. Task #10 TestClock — after #3
6. sloppy-code-guard tightening — last

Exit criteria: `grep -r "Promise<\|async " packages/*/src | grep -v /runtime/ | grep -v test` returns only framework-edge files (Hono routes, WS callbacks, `@effect/platform` handlers, user-hook contracts).
