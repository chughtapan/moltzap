# Effect-native test synchronization

Test-only API surface that lets integration and conformance tests await
specific server-side cleanup steps deterministically. Replaces
wall-clock sleeps (`Effect.sleep("200 millis")`, `CLOSE_DRAIN_MS`,
`FRAME_SETTLE_MS`, ad-hoc `setTimeout` calls) that cannot synchronize
with the per-connection `Effect.onExit` finalizer in `app/server.ts`.

## What ships here

Each test helper takes a `connId` (or `agentId`) and returns an
`Effect<void, CleanupSignalError, never>` that completes when the
corresponding cleanup step has actually run for that id. The
underlying mechanism is an `Effect.Latch` per cleanup step, opened
inside the production finalizer.

Production code never awaits these latches. The signal-publish call
is a tail step inside the existing finalizer; if no test is watching,
the latch is opened-and-discarded.

## What does NOT ship here

- New production behavior. The cleanup ordering inside the per-connection
  `onExit` block (`packages/server/src/app/server.ts`) is unchanged.
- Multi-server coordination. Signals are process-local; same scope as
  the existing `AgentEndpointResolver` and `PresenceService` state.
- Migration of every existing sleep. Migration is a downstream
  implement-senior cutover (one cleanup path per PR); the test helper
  is the prerequisite.

## Cleanup steps the helper observes

The per-connection `onExit` in `app/server.ts:759-805@35c65c9` runs
sequentially:

1. `presenceService.setOffline(agentId)` (if authed)
2. `disconnectionHooks` (sequential)
3. `agentEndpointResolver.remove(agentId, connId)` (if authed)
4. `leaseRegistry.abandon(connId)`
5. `presenceService.removeConnection(connId)`
6. `connections.remove(connId)`

The helper exposes one wait surface per step plus a composite
`awaitConnectionCleanup` that returns when step 6 has fired.

## Why a separate module

- `test-utils/server.ts:53-92@35c65c9` already exposes
  `awaitAgentReady` via a poll loop. Cleanup signals are the inverse:
  await teardown, not bring-up.
- One module per concern (cohesion). The poll-based helpers stay
  where they are; the latch-based helpers live here.
- Module purpose is named by directory shape: `cleanup-signals/`
  reads as "things that signal cleanup completion."

## Wire-up shape

```
app/server.ts onExit finalizer
  └── publishCleanupSignal(step, connId)   // production side, fire-and-forget
                       │
                       ▼
            CleanupSignalRegistry          // process-local
                       │
                       ▼
test code: yield* awaitConnectionCleanup(connId)   // test side, awaits
```

The registry is constructed once per server and stored on the
`CoreApp` test surface alongside `connections` and `leaseRegistry`.
Production server bodies in `app/server.ts:881-915@35c65c9` already
export the relevant handles to the test surface; the registry joins
that list.

## Error channel

`CleanupSignalError` is a discriminated union:
- `{ _tag: "Timeout"; connId; step; timeoutMs }`
- `{ _tag: "NeverRegistered"; connId; step }` — the connection id was
  never seen by the production publisher (test bug or wrong server).

Test callers `Effect.match` against the tag; the architect's tier rule
is that `awaitConnectionCleanup` returns its error channel typed, not
thrown. No `Promise<void>` shorthand.

### Interrupt-observable behavior

The per-connection fiber may be interrupted (server shutdown,
`Scope.close`, parent fiber cancellation). Effect's runtime guarantees
the `onExit` finalizer still runs to completion; the latches still
open. Awaiting tests therefore observe one of two documented outcomes:

1. **Normal interrupt path** — finalizer completes, `publish` fires
   for every step including `connection-removed`, and `awaitStep` /
   `awaitConnectionCleanup` succeed normally. This is the only path
   the migrated tests should rely on.
2. **Interrupt during finalizer body** — if a cleanup step itself is
   interrupted (e.g., a hook never returns and the surrounding scope
   forces shutdown), the latch for the interrupted step never opens.
   Awaiting tests observe `CleanupSignalTimeout` for that step. They
   do NOT observe silent completion; the failure cause is preserved
   through the tagged-error channel so a test author can distinguish
   "finalizer hung" from "test asked too early."

PR1's proof-of-life test must exercise both paths (normal completion
and interrupt during finalizer) to validate that `Effect.Latch`
semantics survive Effect's interrupt model.

## Production type leak avoidance

`CoreApp` exposes `cleanupSignals: CleanupSignalPublisher` — the
write-only narrow surface. The test-utils boot path stores the full
`CleanupSignalRegistry` on `CoreTestServer.cleanupSignals` so tests
can call `awaitStep` / `awaitConnectionCleanup`. Production code path
therefore never sees the `Subscriber` type at all.
