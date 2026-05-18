# Single-Runtime Startup Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Overview

`startRuntimeAgent` is the entry point for launching one agent. It delegates to
`startPendingRuntimeAgent`, which wires a finalizer-guarded scope around the
spawn + readiness check so that any failure path tears down automatically.

```text
caller
  │
  │  startRuntimeAgent(options: RuntimeStartOptions)        fleet.ts → startRuntimeAgent
  │    Effect.scoped(startPendingRuntimeAgent(options))
  │    Effect.withSpan("startRuntimeAgent")
  │
  ▼
startPendingRuntimeAgent                                    fleet.ts → startPendingRuntimeAgent
  │
  ├─ createRuntime(options)                                 fleet.ts → createRuntime
  │    switch options.kind
  │      "openclaw"    → createWorkspaceOpenClawAdapter()   openclaw-adapter.ts → createWorkspaceOpenClawAdapter
  │      "nanoclaw"    → new NanoclawAdapter()              nanoclaw-adapter.ts → NanoclawAdapter
  │      "claude-code" → createWorkspaceClaudeCodeAdapter() claude-code-adapter.ts → createWorkspaceClaudeCodeAdapter
  │
  ├─ Effect.withEarlyRelease(scope)
  │    Effect.addFinalizer(cleanupArmed
  │      ? runtime.teardown() : Effect.void)
  │    runtime.spawn(spawnInput)
  │      ┌── [on error] ──────────────────────────────┐
  │      │   SpawnFailed { agentName, cause, message } │  errors.ts → SpawnFailed
  │      │   finalizer fires → runtime.teardown()      │
  │      └────────────────────────────────────────────┘
  │
  ├─ runtime.waitUntilReady(readyTimeoutMs)
  │    Effect.race(
  │      server.awaitAgentReady(agentId, timeoutMs),        runtime.ts → awaitAgentReady
  │      processExitLoop(processExit)                       adapter-readiness.ts → processExitLoop
  │    )
  │    .flatMap(promoteTimeoutIfProcessExited)              adapter-readiness.ts → promoteTimeoutIfProcessExited
  │    .tap(outcome →
  │          outcome._tag === "Ready" ? void : teardown())
  │
  │    ReadyOutcome._tag = "Ready"
  │      └─ return PendingRuntimeAgent { runtime, releaseStartupCleanup }
  │
  │    ReadyOutcome._tag = "Timeout"
  │      └─ teardown() then fail:
  │         RuntimeReadyTimedOut { agentName, timeoutMs }   errors.ts → RuntimeReadyTimedOut
  │
  │    ReadyOutcome._tag = "ProcessExited"
  │      └─ teardown() then fail:
  │         RuntimeExitedBeforeReady                        errors.ts → RuntimeExitedBeforeReady
  │           { agentName, exitCode, stderr }
  │
  └─ releaseStartupCleanup
       Effect.sync(() => cleanupArmed = false)
       Effect.zipRight(closeStartupScope)
       (disarms the scope finalizer — runtime now caller-owned)
```

## Readiness Polling Detail (`adapter-readiness.ts`)

```text
processExitLoop                                             adapter-readiness.ts → processExitLoop
  └─ Effect.iterate(null, {
       while: state === null,
       body: Effect.sleep("250 millis")
               .zipRight(processExitTick)
     })

processExitTick                                             adapter-readiness.ts → processExitTick
  └─ pollExitCode()           (Fiber.poll on exitFiber)
       Option.None → null     (process still running)
       Option.Some(code) → ReadyOutcome { _tag: "ProcessExited", exitCode, stderr }

promoteTimeoutIfProcessExited                               adapter-readiness.ts → promoteTimeoutIfProcessExited
  If outcome._tag is "Timeout", runs one final processExitTick
  to catch exits that landed in the last 250 ms tick window.
```

`awaitAgentReadyByPolling` is the default `RuntimeServerHandle.awaitAgentReady`
implementation for in-process callers (in `await-agent-ready.ts`). It polls
`connections.getByAgent(agentId)` every 500 ms until at least one connection
has `auth !== null`. Out-of-process callers replace it with a WebSocket presence
subscription (see the `@example` block in `await-agent-ready.ts`).

## See Also

- [Fleet Launch](./02-fleet-launch.md)
- [Per-Adapter Spawn Details](./03-per-adapter-spawn.md)
- [Error Matrix](./06-error-matrix.md)
- [Process State Machine](./07-process-state-machine.md)
