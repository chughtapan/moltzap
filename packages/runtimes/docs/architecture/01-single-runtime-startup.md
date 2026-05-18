# Single-Runtime Startup Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Overview

`startRuntimeAgent` is the entry point for launching one agent. It delegates to
`startPendingRuntimeAgent`, which wires a finalizer-guarded scope around the
spawn + readiness check so that any failure path tears down automatically.

```mermaid
flowchart TD
    A["caller<br>startRuntimeAgent(options: RuntimeStartOptions)<br>fleet.ts → startRuntimeAgent<br>Effect.scoped(startPendingRuntimeAgent)<br>Effect.withSpan(&quot;startRuntimeAgent&quot;)"]
    B["startPendingRuntimeAgent<br>fleet.ts → startPendingRuntimeAgent"]
    C["createRuntime(options)<br>fleet.ts → createRuntime"]
    D1["&quot;openclaw&quot; →<br>createWorkspaceOpenClawAdapter()<br>openclaw-adapter.ts"]
    D2["&quot;nanoclaw&quot; →<br>new NanoclawAdapter()<br>nanoclaw-adapter.ts"]
    D3["&quot;claude-code&quot; →<br>createWorkspaceClaudeCodeAdapter()<br>claude-code-adapter.ts"]
    E["Effect.withEarlyRelease(scope)<br>Effect.addFinalizer(cleanupArmed<br>? runtime.teardown() : Effect.void)<br>runtime.spawn(spawnInput)"]
    SF["SpawnFailed { agentName, cause, message }<br>errors.ts → SpawnFailed<br>finalizer fires → runtime.teardown()"]
    F["runtime.waitUntilReady(readyTimeoutMs)<br>Effect.race(<br>  server.awaitAgentReady(agentId, timeoutMs),<br>  processExitLoop(processExit)<br>)<br>.flatMap(promoteTimeoutIfProcessExited)<br>.tap(outcome → outcome._tag === &quot;Ready&quot; ? void : teardown())"]
    G1["ReadyOutcome._tag = &quot;Ready&quot;<br>→ return PendingRuntimeAgent<br>{ runtime, releaseStartupCleanup }"]
    G2["ReadyOutcome._tag = &quot;Timeout&quot;<br>→ teardown() then fail:<br>RuntimeReadyTimedOut { agentName, timeoutMs }<br>errors.ts → RuntimeReadyTimedOut"]
    G3["ReadyOutcome._tag = &quot;ProcessExited&quot;<br>→ teardown() then fail:<br>RuntimeExitedBeforeReady<br>{ agentName, exitCode, stderr }<br>errors.ts → RuntimeExitedBeforeReady"]
    H["releaseStartupCleanup<br>Effect.sync(() =&gt; cleanupArmed = false)<br>Effect.zipRight(closeStartupScope)<br>(disarms scope finalizer — runtime now caller-owned)"]

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
    PEL["processExitLoop<br>adapter-readiness.ts → processExitLoop<br>Effect.iterate(null, {<br>  while: state === null,<br>  body: Effect.sleep(&quot;250 millis&quot;)<br>          .zipRight(processExitTick)<br>})"]
    PET["processExitTick<br>adapter-readiness.ts → processExitTick<br>pollExitCode()  — Fiber.poll on exitFiber"]
    PEN["Option.None → null<br>(process still running)"]
    PES["Option.Some(code) →<br>ReadyOutcome { _tag: &quot;ProcessExited&quot;, exitCode, stderr }"]
    PT["promoteTimeoutIfProcessExited<br>adapter-readiness.ts → promoteTimeoutIfProcessExited<br>If outcome._tag is &quot;Timeout&quot;, runs one<br>final processExitTick to catch exits that<br>landed in the last 250 ms tick window"]

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
