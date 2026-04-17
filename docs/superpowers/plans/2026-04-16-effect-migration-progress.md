# Effect Migration — Progress Log

> **For downstream consumers.** This document tracks scope expansion and completion state for the Effect migration. Planning artifacts live in `2026-04-16-effect-migration-plans.md` (scope), `2026-04-16-effect-hard-parts.md` (constraints + mandatory fixes), and `2026-04-16-effect-kysely-poc.md` (SQL bridge reference).

**Branch doing the work:** `worktree-bold-elm-c01i` (will land as a series of PRs as scopes converge).

**Last updated:** 2026-04-16, post-`/review` round — mechanical fix-first and ASK-item follow-ups applied. 3 test-writer agents still running for coverage gaps.

---

## What shipped (landed in the working tree, typecheck-clean, tests green)

### Plan A — Core runtime migration

- **A0** — Foundation deps + `runtime/` helpers. `effect`, `@effect/vitest` installed in `@moltzap/server-core` and `@moltzap/client`. Tagged errors (`RpcFailure`, `InvalidParamsError`, `ForbiddenError` server; `NotConnectedError`, `RpcTimeoutError`, `RpcServerError`, `MalformedFrameError`, `AgentNotFoundError` client). Validator bridge (`validateParams(v, input): Effect<T, InvalidParamsError>`). Example `@effect/vitest` tests per package.

- **A1 + A3 + A4 + A5** — Full server Effect migration. **No throws of typed domain errors anywhere.** Router classifies three failure classes distinctly (decode / typed domain / defect) and maps to wire `ResponseFrame.error`. Every service (`auth`, `participant`, `conversation`, `delivery`, `message`, `user`) is Effect-returning. AppHost public methods return Effects. `DefaultPermissionService` uses `Effect.async` with typed `PermissionDeniedError | PermissionTimeoutError` channels **and** a synchronous interrupt cleanup (`clearTimeout` + Map delete) so fiber interrupts don't leak pending timers. `admitAgentsAsync` uses `Effect.forkDaemon`. `runHookWithTimeout` uses `Effect.timeout` + `Effect.catchTag`. `Promise.allSettled` in admission → `Effect.all([...], { concurrency: "unbounded", mode: "either" })`. `ContactService.areInContact: Effect<boolean, never>`. All `RpcError` class uses gone.

- **A6** — Client WS runtime Effect-native. `ws-client.ts` internals are `ManagedRuntime` + `Ref<HashMap<string, Deferred>>` + `Effect.timeout` + scope-managed socket. New `packages/client/src/runtime/frame.ts` decodes inbound frames via protocol's pre-compiled AJV validators. **§5 hard-parts behavioral fixes (all four):**
  1. `connect()` no longer hangs on pre-open close/error — settles immediately via single-shot latch.
  2. Pending RPCs fail fast with `NotConnectedError` on disconnect (previously waited 30s for timeout).
  3. Automatic retry for non-idempotent RPCs **removed**. Silent retry of `messages/send` / `conversations/create` / `apps/create` was a correctness bug; now every method gets one attempt.
  4. Central typed decode for inbound frames via `decodeFrame` — malformed frames logged and dropped (per-connection rate-limited 1/50), never resolve a pending Deferred.

- **A7** — Client `MoltZapService` Ref migration + **protocol contract drift bug fix** (§6.1). `sendToAgent` was calling `agents/lookupByName` with `{ name }` but protocol requires `{ names: string[] }`; return shape was `{ agent: { id } }` but protocol returns `{ agents: AgentCard[] }`. Tests reinforced the bug. Both fixed. All 7 stateful Maps moved to `Ref<HashMap>`. `pendingNameLookups` uses `Deferred` for coalescing. Public API is **Effect-native** (`connect`, `send`, `sendToAgent`, `close`) — `sendToAgent` error channel now `ServiceRpcError | AgentNotFoundError`. Handlers are preserved across `close()`/`connect()` cycles (prior draft wiped them).

### Plan B — HTTP transport replacement

- **Hono → `@effect/platform` / `@effect/platform-node`** landed. All HTTP routes (`/health`, `/api/v1/auth/register`, `/api/v1/permissions/resolve`) served via `HttpRouter` + `HttpMiddleware.cors`. WebSocket kept on `ws` package (POC-guided decision per hard-parts §5). WS upgrade attached manually to the Node `http.Server` exposed from `NodeHttpServer.layerContext`. Zero `hono` imports remain.

### Plan C — Kysely bridge

- **C2** — Custom `@effect/sql-kysely` replacement via direct prototype patching (`packages/server/src/db/effect-kysely-toolkit.ts`). The published Kysely / Pg variants wrap every query result in a `Proxy` whose `get` trap infinite-recurses when `Buffer.from(proxy)` hits a `bytea` column. Our toolkit adds `Effectable.CommitPrototype` + a `commit` method to each builder prototype — builders are now Effects without the Proxy layer. Works against both `pg` (prod) and PGlite (quickstart). `@effect/sql-kysely/Pg` is imported **type-only** (`import type {}`) — the runtime side-effects re-activate the Proxy.
- Message insert on bytea columns uses `Effect.tryPromise` + `SqlError` (was `Effect.promise`, which would have turned DB errors into defects).

### Layer wiring + dependency injection

- **Task #6 A2** — Layer-based `createCoreApp` wiring. **14** `Context.Tag`s now (added `UserServiceTag` in the `/review` round — UserService was previously wired via the last mutable `setUserService` setter). 5-tier Layer composition via `Layer.provideMerge`. `createCoreApp` destructures a `ResolvedServices` object from a single `Effect.runSync(resolveServices.pipe(Effect.provide(FullLive)))`. `setUserService` is gone; `CoreConfig.userService?: UserService` flows through the Layer. Optional contact + permission services remain imperative setters for now (they gate per-request behavior, not construction).

### Config

- **Task #8** — `Effect.Config` native config loader. `loadConfigFromFile(path)` returns `Effect<MoltZapConfig, ConfigLoadError>`. `ConfigLoadError` is a `Data.TaggedError` with discriminated `kind: "read" | "yaml" | "env" | "validation"`. `${ENV_VAR}` interpolation preserved, with empty-string env vars treated as missing (prevents silent `https:///callback` broken-URL footguns).

### Protocol — typed RPC manifest (Task #13)

- **`defineRpc({ name, params, result })` factory** in `@moltzap/protocol` generates a typed manifest with pre-compiled AJV validator and `Static<...>` param/result types in one place.
- **`rpc-registry.ts`** enumerates every method as a typed tuple — `RpcMethodName` becomes a branded union type. Client `sendRpc(Manifest, params)` overload compiles away stringly-typed method names.
- **`defineMethod(manifest, { handler })`** on the server: every handler's params + return type are derived from the manifest. **All 23 handlers migrated**; the legacy `defineMethod<TParams>({ validator, handler })` overload is **deleted**.
- **All back-compat re-derivations removed** from `packages/protocol/src/schema/methods/*.ts` (the `XxxParamsSchema` / `XxxParams` / `XxxResultSchema` / `XxxResult` exports, ~220 lines). Downstream consumers use `Static<typeof Manifest.paramsSchema>` at the import site. The stale `packages/protocol/src/optional/contact-{events,methods}.ts` re-export modules are deleted; their `package.json` subpath exports removed.

### Evals, channel plugins

- **Evals Effect migration** — `runner.ts` 4-phase pipeline via `Effect.forEach { concurrency }`; LLM-judge retry+timeout via `Schedule.exponential().jittered` + `Effect.retry`; container lifecycle via `Effect.acquireRelease`; `DockerManager.startAgent` and friends return Effects with `ContainerError` in the error channel. `nanoclaw-manager` `stopAgent`/`stopAll` dedup via private `safeStop` helper.
- **OpenClaw** — factory closure for `activeClients` (was module-global). `try/catch` ladders → `Effect.tryPromise` + `Effect.catchAll`. `new Promise(r => abortSignal.addEventListener("abort", r))` → `Effect.async` with proper cleanup. `contacts/list` call fixed to pass `{}` (the previous `{ status: "accepted" }` was rejected by AJV and silently swallowed).
- **Nanoclaw** — cosmetic Effect.runPromise wrappers at plugin edge for consistency.

### Task #7 — FiberRef / Context.Tag for connId

- `AsyncLocalStorage<string>` replaced with `ConnIdTag` provided at the WS dispatch edge via `Effect.provideService(ConnIdTag, connId)`. `getConnId` prop threading through every handler factory's `deps` is gone.

### Task #9 — Effect logging Layer

- `Logger.make` backed by the Pino instance (`effectLogger` + `LoggerLive`). Services call `Effect.logInfo(...).pipe(Effect.annotateLogs({...}))` — Effect's log annotations become Pino's first-arg object, so operator-facing log format is unchanged. Logger is wrapped in try/catch + stderr fallback so late-shutdown log writes can't become Effect defects.

### Task #11 — Layer-based test fakes

- `vi.mock` of our own services replaced with typed test fakes (`packages/server/src/test-utils/fakes.ts`, `packages/client/src/test-utils/fake-service.ts`). Fakes are structurally typed against the service interface, so contract drift fails at compile time.

### `/review` round (post-migration fix-first)

Full `/review` ran across the accumulated branch diff with 5 specialists (testing, maintainability, security, performance, api-contract), a Claude adversarial subagent, and Codex structured review. ~70 findings; 24 auto-fixed mechanically; 8 ASK items surfaced. User answered the ASKs, and the following landed:

- **Hooks fail-close by default**: `runBeforeMessageDelivery` synthesizes `{ block: true }` on hook timeout or hook-throw. Security/moderation hooks can't be bypassed by a slow or crashing handler. Operator-visible `app/hookTimeout` event still fires. Integration tests updated.
- **UserService Layer** (see A2 above): `UserServiceTag` + Layer wiring; `setUserService` setter deleted.
- **`defineMethod` manifest migration**: all 23 handlers converted; legacy overload deleted.
- **Back-compat re-derivations removed** from protocol (see typed RPC manifest).
- **Security**: socketPath sanitizes agentId against path traversal; Unix socket chmod `0600` after listen; path-traversal defense also applies to the server-assigned agentId.
- **Correctness**: `coalesce` (client + server) wrapped in `Effect.uninterruptible` so `Ref.modify` + `forkDaemon` can't be split by fiber interrupt (which would leave a zombie Deferred). `Effect.async` callbacks in `DefaultPermissionService.requestPermission` + `checkCapability` now return cleanup Effects so interrupts clear timers + Map entries. `DefaultPermissionService.destroy()` rejects with the real resource name (was mislabeled as "shutdown" in PermissionDeniedError.resource).
- **Tagged errors** for attestation timeout / skill-mismatch (was error-message string-matching). `Effect.promise(...).then(ok, err)` in onJoin wrapper → `Effect.tryPromise` with a catch.
- **Server shutdown race** commented but not solved (acknowledged: `appHost.destroy()` runs before WS close).
- **Maintainability cleanup**: `test-proxy{,2-5}.mjs` scratch scripts deleted; dead `log` child-logger map removed; named constants for `BASE_RECONNECT_DELAY_MS`, `DELIVERY_TRACKING_MAX_PARTICIPANTS`, `SHUTDOWN_DRAIN_MS`, `BYSTANDER_SETTLE_MS`; `MAX_MESSAGES_PER_CONV = Infinity` retained with a bounding pattern (user explicitly wants no cap yet).
- **`peekContextEntries` determinism**: sort conversations by recency before `maxConversations` slicing (HashMap iteration order was hash-based).

### Test status

- **Server unit:** 70/70 pass.
- **Server integration:** 79/79 pass (24 test files, PGlite-backed).
- **Client unit:** 130/130 pass (includes real integration suite with real server).
- **Protocol:** 50/50 pass.
- **Openclaw:** 77/77 pass.
- **Full monorepo `tsc`:** clean across all 6 buildable packages.

---

## What's in flight

| Scope | Status |
|---|---|
| `/review` item #8: add tests for the 25 coverage gaps flagged by the testing specialist (coalesce concurrency, drainCoalesceMap, catchSqlErrorAsDefect, Layer composition, router ForbiddenError, webhook TTL expiry, handleSocketRequestEffect edge cases, channel-core fanout guards, malformed-frame log cadence, runHookWithTimeout paths, userValidationCache coalesce, etc.) | 3 agents running in parallel |

---

## What's queued (not yet started)

| Scope | Gate |
|---|---|
| **Task #10 TestClock for timeout-heavy integration tests** — replace real `setTimeout` sleeps with `TestClock.adjust(Duration.seconds(N))`. Hot targets: `33-session-failure`, `30-permissions`, `30-app-hooks`, `31-session-close` | After test-gap agents land (avoid merge conflicts) |
| **Tighten `sloppy-code-guard.sh`** — reject `Promise<` / `async ` outside documented boundary files (transport edges, user-facing hook callbacks, framework contracts) | After everything else |
| **Test pyramid rebalance** (tracked as GitHub issue #77) — move ~50 integration tests to Layer-based unit tests. Expected 4x CI speedup | Separate follow-up |

---

## Explicit non-goals for this migration

- **Do not** introduce a parallel `src/effect/` tree. Every migration slice replaces its imperative counterpart in-place.
- **Client public API is now Effect-native.** Downstream consumers (nanoclaw-channel, openclaw-channel, evals) call `Effect.runPromise(coreEffect)` at the plugin edge, then stay Effect internally. No Promise-based wrapper layer is maintained.
- **Do not** migrate WebSocket transport to `@effect/platform`'s Socket. Hard-parts §5 flags it as higher-risk and incidental to this migration. Keep `ws` package; just Effect-manage the lifecycle.
- **Do not** drop PGlite. Zero-Docker quickstart is a product feature. The custom `effect-kysely-toolkit` (direct prototype patching) preserves it.
- **Do not** keep back-compat shims in `@moltzap/protocol`. Server + client ship together; there are no external consumers pinning old type names.

---

## Why this matters for downstream

- **Typed errors:** every RPC failure has a discriminated tag. Adding a new error code is a one-line `Data.TaggedError` declaration; the router pattern-matches on `_tag`. No more "InternalError" as a catch-all for silent data corruption.
- **Structured concurrency:** `Effect.forkDaemon` for background admission, `Effect.uninterruptible` for atomic coalesce install, `Scope`-managed WS sockets, `ManagedRuntime` per client. No more orphaned Promises that outlive the request that started them.
- **Layer-based DI:** tests swap services for fakes with one line. The `sendToAgent` contract drift that shipped as a bug (fixed in A7) becomes a compile error with Layer-typed fakes + the typed RPC manifest.
- **Single source of truth for RPC contracts:** typed `defineRpc` manifest unifies schema + types + validator + name per method. `sendRpc<AgentsLookupByName>({ names: [...] })` is compile-checked against the manifest. Enables future SDK codegen.
- **Fail-closed hooks:** app hooks (moderation, content filters) can no longer be bypassed by a slow or crashing handler. Default behavior is safer; explicit per-hook policy can be added later without changing the default.
- **Security hardening:** Unix socket chmod `0600`, agentId sanitization against path traversal, empty-env-var detection in config loader, malformed-frame log rate-limiting (client + server).

---

## Rough landing order

1. ✅ Server migration (Plans A0–A5 + Plan B + C2)
2. ✅ Client migration (A6 + A7) with Effect-native public API
3. ✅ Task #6 Layers + #8 Config + #13 RPC manifest + #7 FiberRef + #9 Logging Layer + #11 Test fakes + evals + channels
4. ✅ `/review` round: mechanical fix-first + ASK-item follow-ups
5. 🔄 Test coverage for `/review`-flagged gaps (in flight)
6. ⏳ Task #10 TestClock
7. ⏳ sloppy-code-guard tightening

Exit criteria: `grep -r "Promise<\|async " packages/*/src | grep -v /runtime/ | grep -v test` returns only framework-edge files (WS callbacks, `@effect/platform` handlers, user-hook contracts, test adapters).
