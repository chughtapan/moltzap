# Effect Migration Hard Parts

> **Purpose:** This document is for the agents implementing the migration. It focuses on the places where a naive “replace `Promise` with `Effect`” port will miss the real value or preserve existing bugs.

**Scope:** `@moltzap/server-core` and `@moltzap/client` internals only. `@moltzap/protocol` remains TypeBox/AJV and framework-neutral.

**Main point:** Effect should not just re-express the current runtime. It should deliberately fix the current weak spots:
- hanging connection attempts
- duplicate message sends after timeout retries
- state machines encoded as mutable `Map`s plus timers
- fire-and-forget session admission work
- request-scoped context smuggled through `AsyncLocalStorage`
- flaky sleep-based tests

---

## 1. What Must Improve

The migration should force these outcomes:

- No RPC request may be retried automatically if doing so can duplicate side effects.
- Disconnecting a socket must interrupt or fail all pending work immediately.
- Long-lived background tasks must be owned by a `Scope`, not leaked through timers.
- Session admission must become structured concurrency, not detached async work.
- Request-scoped data such as `connId` must be explicit in Effect context, not hidden global state.
- Timeout-heavy tests must move toward `TestClock`, not `setTimeout` sleeps.

If a migration slice does not improve one of those classes of behavior, it is probably only translating syntax.

---

## 2. Build Trap: Protocol `dist` Is A Real Dependency

### What is happening

`packages/server` imports `@moltzap/protocol`, and TypeScript resolves that package through the workspace package exports. In practice, this means individual `server` builds rely on `packages/protocol/dist`, not just `packages/protocol/src`.

That caused a misleading failure in this checkout:
- `packages/protocol/src` already contained app schemas and new error codes
- `packages/protocol/dist` was stale and missing them
- `pnpm --filter @moltzap/server-core build` then reported many fake “missing export” errors in `packages/server/src/app/*`

After rebuilding protocol first:
- `pnpm --filter @moltzap/protocol build`
- `pnpm --filter @moltzap/server-core build`

the server build passed.

### Guidance

- Always rebuild `@moltzap/protocol` before validating `server` or `client` after protocol changes.
- Do not spend time “fixing” server compile errors that are really stale protocol artifacts.
- Long-term, consider TS project references or a workspace dev setup that reduces this stale-`dist` trap.

---

## 3. RPC Boundary: The Type-Safety Hole Is In `defineMethod`

**Primary file:** `packages/server/src/rpc/context.ts`

### Current problem

The current helper:

```ts
export function defineMethod<TParams>(def: {
  validator: (data: unknown) => boolean
  handler: (params: TParams, ctx: AuthenticatedContext) => Promise<unknown>
  requiresActive?: boolean
}): RpcMethodDef {
  return def as unknown as RpcMethodDef
}
```

erases the very type it claims to protect. It relies on:
- the validator being correct
- the handler author choosing the right `TParams`
- no drift between protocol schema and handler assumptions

### Why this matters

This is the server’s main “typed” boundary, but the actual runtime contract is:
- `unknown` payload
- AJV boolean validator
- cast
- thrown error on mismatch later

Effect should fix this by making validation and domain execution part of the same typed program.

### Recommended pattern

- Keep AJV as the wire validator.
- Add a bridge that turns “AJV boolean + current input” into:
  - `Effect.succeed(typedParams)` on success
  - `Effect.fail(InvalidParamsError)` on failure
- Make each RPC method explicitly typed as:

```ts
type RpcProgram<P, A, E, R> =
  (params: P, ctx: AuthenticatedContext) => Effect.Effect<A, E, R>
```

- Route failures through a single error-translation layer at the router boundary.

### Extra improvement to take

The router should distinguish:
- protocol decode failures
- domain failures
- defects / unexpected exceptions

Those are currently collapsed too early into `RpcError` or `Internal error`.

---

## 4. Request Context: Replace `AsyncLocalStorage` With Explicit Effect Context

**Primary file:** `packages/server/src/app/server.ts`

### Current problem

`connId` is carried through `AsyncLocalStorage` so handlers can call `getConnId()` without taking it as an explicit parameter.

This works, but it is fragile:
- hidden dependency
- difficult to test in isolation
- tied to Node async context semantics
- awkward once logic starts forking work

### Recommended pattern

- Use an Effect service or `FiberRef` to represent request/session context.
- Set the connection context at the WS edge just before executing the request program.
- Read it where needed from the Effect environment.

### What to avoid

- Do not keep `getConnId: () => string` closures as the long-term solution.
- Do not reintroduce ad hoc ambient globals inside the Effect runtime.

### Benefit

This makes per-request state explicit and safe across Effect fibers, and it removes one of the main reasons the current code needs transport-level wiring to leak into domain handlers.

---

## 5. Client WebSocket Runtime: This Is A Real Runtime, Not A Utility

**Primary file:** `packages/client/src/ws-client.ts`

### Current problems

#### 5.1 `connect()` can hang

`connect()` only resolves from the `open -> auth/connect` path. If the socket closes or errors before open, the returned Promise can remain unsettled while reconnect logic runs in the background.

#### 5.2 Pending RPCs survive disconnect until timeout

`pendingRequests` are only failed by timeout or response. A disconnect does not fail them immediately.

#### 5.3 Timeout retry can duplicate side effects

`sendRpc()` retries once on timeout for every method except `auth/connect`:

```ts
if (err.message.startsWith("RPC timeout:") && method !== "auth/connect") {
  return attempt()
}
```

This is unsafe for non-idempotent methods like:
- `messages/send`
- `conversations/create`
- `apps/create`

A slow response can become a duplicated action.

#### 5.4 Inbound frames are parsed but not validated

Inbound JSON is `JSON.parse(...) as Record<string, unknown>` and then branched by shape. Event payloads are trusted too early.

### Recommended pattern

- Treat the websocket client as a scoped runtime service.
- Use one connection loop fiber that owns:
  - open
  - authenticate
  - read
  - write
  - reconnect policy
- Use:
  - `Mailbox` or `Queue` for inbound frames
  - `Deferred` per pending RPC
  - `Ref` / `SynchronizedRef` for connection state
  - `Schedule.exponential(...).pipe(Schedule.jittered)` for reconnect
  - `Effect.async` / `Effect.tryPromise` at the `ws` edge

### Mandatory behavioral fix

- Remove automatic retry for non-idempotent RPCs.
- If retry support is desired, it must be opt-in and limited to explicitly idempotent methods.

### Public API guidance

- The external API may stay Promise-based for now.
- Internally, the client should be driven by `ManagedRuntime` or a scoped runtime helper.

---

## 6. `MoltZapService`: Contract Drift And Mixed Responsibilities

**Primary file:** `packages/client/src/service.ts`

### Current problem classes

#### 6.1 Contract drift in `sendToAgent`

`sendToAgent()` currently assumes:

```ts
await this.sendRpc("agents/lookupByName", { name: agentName })
// result as { agent: { id: string } }
```

but the protocol and server define:
- request: `{ names: string[] }`
- result: `{ agents: AgentCard[] }`

The unit tests in `packages/client/src/service.test.ts` are also written against the stale singular shape, so they currently reinforce the bug.

#### 6.2 Lifecycle, caching, eventing, and local socket server all live together

`MoltZapService` currently owns:
- connection lifecycle
- inbound event routing
- message caches
- agent-name lookup caching
- cross-conversation context state
- local socket server lifecycle

This is too much for one imperative class and too much shared mutable state for a direct line-by-line port.

#### 6.3 Event subscriptions are push-arrays with no unsubscription story

The current `on(...)` API appends handlers to arrays and never returns an unsubscribe handle.

### Recommended split

- Keep `MoltZapWsClient` or its replacement focused on transport/runtime only.
- Move higher-level client state into a separate Effect service layer.
- Model event subscriptions with:
  - `PubSub`
  - `SubscriptionRef`
  - or a small managed subscription abstraction

### Specific migration opportunity

The cross-conversation context markers currently depend on mutable commit semantics. That is fine, but it should be explicit immutable state transitions through `Ref.modify`, not incidental mutation across methods.

---

## 7. AppHost: This Is The Hardest Server Migration

**Primary file:** `packages/server/src/app/app-host.ts`

### Why it is hard

`AppHost` is not just “a service”. It is a state machine with:
- persistent DB state
- in-memory reverse indexes
- timed hook execution
- pending challenge state
- pending permission coalescing
- background admission flows
- event fanout

A line-by-line port would keep all the real complexity and just hide it in `Effect.sync`.

### Current structural issues

#### 7.1 Session admission is detached async work

`createSession()` persists data, returns, and then kicks off `admitAgentsAsync(...)` as background work. Final session status updates then happen later and out of band.

That is why tests like `33-session-failure.integration.test.ts` need sleeps before reading final DB state.

#### 7.2 Challenge and permission state use ad hoc `Map + setTimeout`

This affects:
- `pendingChallenges`
- `inflightPermissions`
- default permission callback state
- hook timeout wrappers

These all want interruption-aware resources, not raw timers.

#### 7.3 Permission coalescing semantics are subtle

`inflightPermissions` coalesces on:

```ts
${ownerUserId}:${session.appId}:${perm.resource}
```

but the default permission resolver keys pending permission prompts by:

```ts
${sessionId}:${agentId}:${resource}
```

That means a single live prompt can satisfy multiple concurrent requests across sessions for the same user/app/resource, but only one session/agent pair is represented in the prompt payload. That may be acceptable, but it must be an explicit design decision, not an accidental side effect of string keys.

#### 7.4 Hook timeout is fail-open, but only informally

`runHookWithTimeout()` currently:
- races the hook against a timer
- aborts via `AbortController`
- logs and returns `null` on timeout or error

The fail-open behavior is important, but it is not encoded as a first-class policy.

### Recommended pattern

- Represent in-memory AppHost state as an Effect-managed state record:
  - manifests
  - hooks
  - session/conversation indexes
  - pending challenges
  - inflight permissions
- Use:
  - `Ref` / `SynchronizedRef` for state
  - `Deferred` for pending challenge and permission completions
  - `FiberMap` for admission/background fibers keyed by session or agent
  - `Effect.timeout` for hook/challenge/permission time windows
  - `Scope` so all background work is interrupted on server shutdown

### Mandatory behavioral fix

Do not preserve the current “return now, maybe finish later, tests sleep” model for critical session state changes unless the asynchronous boundary is intentionally part of the product behavior.

If session readiness/failure is logically part of session creation, the migration should make that explicit and testable.

---

## 8. Presence Is Wrong For Multi-Connection Agents

**Primary files:**
- `packages/server/src/app/server.ts`
- `packages/server/src/services/presence.service.ts`

### Current problem

On websocket close, the server does:

```ts
if (conn?.auth) {
  presenceService.setOffline(conn.auth.agentId)
}
```

This marks an agent offline whenever any authenticated connection closes, even if that agent still has other live connections.

### Why this matters

The migration is a chance to fix the semantic model, not just the implementation shape.

### Recommended model

- Track authenticated live connection count per agent.
- Compute derived presence from connection count plus explicit away/offline state if needed.
- Use `SubscriptionRef` or a dedicated presence state service to publish changes deterministically.

### Non-goal

- Do not preserve “offline on any close” just because tests currently don’t catch it.

---

## 9. Transport And Domain Need A Cleaner Split On The Server

**Primary file:** `packages/server/src/app/server.ts`

### Current problem

The websocket route currently handles:
- parse errors
- auth gating
- dispatch
- request-scoped context plumbing
- post-auth connection hooks
- presence updates on close

This is a lot of policy in one transport callback.

### Recommended split

- Keep the WS edge thin:
  - decode raw bytes to frames
  - pass frames to a session/runtime service
  - encode responses back to bytes
- Move:
  - auth state transitions
  - connection subscriptions
  - connection hook execution
  - close semantics
  - request dispatch
  into services/effects owned by Layers

### Why Effect helps here

The transport callback can become mostly `runPromise` over a typed session effect, rather than a place where business logic accumulates because it has convenient access to `ws`, `db`, and `connections`.

---

## 10. Testing: The Migration Should Pay Off Here Immediately

**Primary files:**
- `packages/server/src/__tests__/integration/*`
- `packages/client/src/__tests__/*`
- `packages/client/src/service.test.ts`

### Current problems

- Many tests rely on `await new Promise((r) => setTimeout(r, 200/500/2000))`.
- Some correctness relies on eventual consistency from detached background work.
- Client unit tests contain fake response shapes that already drift from the real protocol.

### Recommended pattern

- Migrate timeout/retry/hook flows to `@effect/vitest`.
- Use `TestClock` for:
  - reconnect backoff
  - RPC timeout handling
  - hook timeout
  - permission timeout
  - challenge timeout
- Use shared Layers for test fixtures instead of repeated bespoke setup.

### Minimum expected benefit

If the client reconnect or AppHost timeout logic still requires real sleeps after the migration, the migration did not go deep enough.

---

## 11. Recommended Effect Building Blocks For This Repo

These are the modules that best match the actual hard parts in this codebase.

### For runtime and resource ownership

- `Effect.async`
- `Effect.tryPromise`
- `Effect.acquireRelease`
- `Effect.runFork`
- `Scope`
- `ManagedRuntime`

### For state and concurrency

- `Ref`
- `SynchronizedRef`
- `SubscriptionRef`
- `Deferred`
- `FiberMap`
- `Mailbox` or `Queue`

### For retries and time

- `Schedule.exponential`
- `Schedule.jittered`
- `Effect.timeout`
- `TestClock`

### For wiring and tests

- `Context.Tag`
- `Layer`
- `@effect/vitest`

---

## 12. Concrete Guidance By Migration Slice

### Auth / router slice

- Fix `defineMethod` first.
- Introduce typed failures before touching all services.
- Replace `AsyncLocalStorage` with explicit request context.

### Client runtime slice

- Fix hanging connect behavior and pending-request interruption first.
- Remove duplicate timeout retry before doing cosmetic refactors.
- Decode inbound frames centrally.

### AppHost slice

- Model pending challenge/permission waits with `Deferred`.
- Move admission flows under structured concurrency.
- Decide and document permission-coalescing semantics before rewriting them.

### Presence slice

- Fix multi-connection semantics as part of the refactor, not after.

### Test slice

- Replace sleep-based timeout tests as soon as the runtime uses Effect clocks.

---

## 13. Anti-Patterns To Avoid

- Do not wrap existing `async` methods in `Effect.tryPromise` and call it done.
- Do not keep mutable `Map`s as the hidden source of truth behind Effect façades.
- Do not preserve raw timer orchestration if `Effect.timeout` or `Schedule` can own it.
- Do not keep automatic retry for non-idempotent RPCs.
- Do not introduce a second runtime tree that mirrors the old one.
- Do not trust current unit-test fakes more than the protocol package.

---

## 14. References

Official Effect docs used for the recommended patterns:

- Effect docs index: `https://effect-ts.github.io/effect/`
- `Effect.async`, `Effect.promise`, `Effect.tryPromise`, `Effect.runFork`:
  `https://effect-ts.github.io/effect/effect/Effect.ts.html`
- `ManagedRuntime.make`:
  `https://effect-ts.github.io/effect/effect/ManagedRuntime.ts.html`
- `FiberMap.make`, `FiberMap.run`, `FiberMap.awaitEmpty`:
  `https://effect-ts.github.io/effect/effect/FiberMap.ts.html`
- `SubscriptionRef.make` and change-stream semantics:
  `https://effect-ts.github.io/effect/effect/SubscriptionRef.ts.html`
- `ScopedRef`:
  `https://effect-ts.github.io/effect/effect/ScopedRef.ts.html`
- `Mailbox.make`:
  `https://effect-ts.github.io/effect/effect/Mailbox.ts.html`
- `@effect/vitest` methods `effect`, `layer`, `scoped`, `live`, `scopedLive`:
  `https://effect-ts.github.io/effect/vitest/index.ts.html`
