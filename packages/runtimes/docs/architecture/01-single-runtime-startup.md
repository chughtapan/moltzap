# Single-Runtime Startup Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Overview

`startRuntimeAgent` is the entry point for launching one agent. It delegates to
`startPendingRuntimeAgent`, which wires a finalizer-guarded scope around the
spawn + readiness check so that any failure path tears down automatically.

```mermaid
flowchart TD
    A["caller\nstartRuntimeAgent(options: RuntimeStartOptions)\nfleet.ts → startRuntimeAgent\nEffect.scoped(startPendingRuntimeAgent)\nEffect.withSpan(&quot;startRuntimeAgent&quot;)"]
    B["startPendingRuntimeAgent\nfleet.ts → startPendingRuntimeAgent"]
    C["createRuntime(options)\nfleet.ts → createRuntime"]
    D1["&quot;openclaw&quot; →\ncreateWorkspaceOpenClawAdapter()\nopenclaw-adapter.ts"]
    D2["&quot;nanoclaw&quot; →\nnew NanoclawAdapter()\nnanoclaw-adapter.ts"]
    D3["&quot;claude-code&quot; →\ncreateWorkspaceClaudeCodeAdapter()\nclaude-code-adapter.ts"]
    E["Effect.withEarlyRelease(scope)\nEffect.addFinalizer(cleanupArmed\n? runtime.teardown() : Effect.void)\nruntime.spawn(spawnInput)"]
    SF["SpawnFailed { agentName, cause, message }\nerrors.ts → SpawnFailed\nfinalizer fires → runtime.teardown()"]
    F["runtime.waitUntilReady(readyTimeoutMs)\nEffect.race(\n  server.awaitAgentReady(agentId, timeoutMs),\n  processExitLoop(processExit)\n)\n.flatMap(promoteTimeoutIfProcessExited)\n.tap(outcome → outcome._tag === &quot;Ready&quot; ? void : teardown())"]
    G1["ReadyOutcome._tag = &quot;Ready&quot;\n→ return PendingRuntimeAgent\n{ runtime, releaseStartupCleanup }"]
    G2["ReadyOutcome._tag = &quot;Timeout&quot;\n→ teardown() then fail:\nRuntimeReadyTimedOut { agentName, timeoutMs }\nerrors.ts → RuntimeReadyTimedOut"]
    G3["ReadyOutcome._tag = &quot;ProcessExited&quot;\n→ teardown() then fail:\nRuntimeExitedBeforeReady\n{ agentName, exitCode, stderr }\nerrors.ts → RuntimeExitedBeforeReady"]
    H["releaseStartupCleanup\nEffect.sync(() =&gt; cleanupArmed = false)\nEffect.zipRight(closeStartupScope)\n(disarms scope finalizer — runtime now caller-owned)"]

    A --> B
    B --> C
    C --> D1
    C --> D2
    C --> D3
    D1 & D2 & D3 --> E
    E -->|"spawn error"| SF
    E --> F
    F --> G1
    F --> G2
    F --> G3
    G1 --> H
```

## Readiness Polling Detail (`adapter-readiness.ts`)

```mermaid
flowchart TD
    PEL["processExitLoop\nadapter-readiness.ts → processExitLoop\nEffect.iterate(null, {\n  while: state === null,\n  body: Effect.sleep(&quot;250 millis&quot;)\n          .zipRight(processExitTick)\n})"]
    PET["processExitTick\nadapter-readiness.ts → processExitTick\npollExitCode()  — Fiber.poll on exitFiber"]
    PEN["Option.None → null\n(process still running)"]
    PES["Option.Some(code) →\nReadyOutcome { _tag: &quot;ProcessExited&quot;, exitCode, stderr }"]
    PT["promoteTimeoutIfProcessExited\nadapter-readiness.ts → promoteTimeoutIfProcessExited\nIf outcome._tag is &quot;Timeout&quot;, runs one\nfinal processExitTick to catch exits that\nlanded in the last 250 ms tick window"]

    PEL --> PET
    PET --> PEN
    PET --> PES
    PES --> PT
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
