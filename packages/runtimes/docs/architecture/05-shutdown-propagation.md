# Shutdown Propagation

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Caller-Initiated via `RuntimeFleet.stopAll()`

```text
fleet.stopAll()
  → teardownStartedAgents(startedAgents)               fleet.ts → teardownStartedAgents
       Effect.forEach([...startedAgents].reverse(),
         agent => agent.runtime.teardown(),
         { concurrency: 1 })
       Reverse order = last-spawned torn down first.
```

## OpenClaw Teardown (`openclaw-adapter.ts → OpenClawAdapter.doTeardown`)

```text
OpenClawAdapter.doTeardown()
  1. Effect.sync:
       if state === null || state.tornDown → return null
       state.tornDown = true
       capture { process, stateDir }
  2. pollExitCode(proc) — Fiber.poll(exitFiber)
       Option.Some → process already exited, skip signal
       Option.None → waitAfterSigterm(proc):            openclaw-adapter.ts → waitAfterSigterm
         proc.kill("SIGTERM")
         timeout(OPENCLAW_TERM_WAIT_MS = 10 000 ms)     openclaw-adapter.ts → OPENCLAW_TERM_WAIT_MS
         if still running:
           proc.kill("SIGKILL")
           timeout(OPENCLAW_KILL_WAIT_MS = 5 000 ms)    openclaw-adapter.ts → OPENCLAW_KILL_WAIT_MS
  3. Scope.close(proc.scope, Exit.succeed(undefined))
       Runs Command.start's kill finalizer +
       stdout/stderr fiber finalizers.
  4. fileSystem.remove(stateDir, { recursive: true })
       Removes temp state dir (openclaw.json, workspace/,
       logs/, plugin symlinks).
       Errors are caught and logged as warnings.
```

## ClaudeCode Teardown (`claude-code-adapter.ts → ClaudeCodeAdapter.doTeardown`)

```text
ClaudeCodeAdapter.doTeardown()
  1. Guard: if !state || state.tornDown → return void
     state.tornDown = true
     capture { process: proc, stateDir }
  2. pollExitCode(proc) — Fiber.poll(proc.exitFiber)
       Option.Some → skip signal (already exited)
       Option.None → waitAfterSigterm(proc):            claude-code-adapter.ts → waitAfterSigterm
         proc.kill("SIGTERM")
         timeout(TERM_WAIT_MS = 10 000 ms)              claude-code-adapter.ts → TERM_WAIT_MS
         if still running:
           proc.kill("SIGKILL")
           timeout(TERM_WAIT_MS = 10 000 ms)
     Note: No explicit process-group kill — SIGTERM on
     claude propagates to cc-channel (its MCP child)
     naturally via the process hierarchy.
  3. Scope.close(proc.scope, Exit.succeed(undefined))
  4. fileSystem.remove(stateDir, { recursive: true })
       Errors caught and logged as warnings.
```

## Nanoclaw Teardown (`nanoclaw-adapter.ts → NanoclawAdapter.doTeardown`)

```text
NanoclawAdapter.doTeardown()
  1. Effect.sync:
       if !state || state.tornDown → return null
       state.tornDown = true
       return state.handle
  2. stopNanoclawRuntimeEffect(handle)               nanoclaw-process.ts → stopNanoclawRuntimeEffect
       proc.isRunning?
         true:
           killProcessAndWait(proc, "SIGTERM",         nanoclaw-process.ts → killProcessAndWait
             GRACEFUL_STOP_MS = 3 000 ms)
           if still running:
             killProcessAndWait(proc, "SIGKILL",
               GRACEFUL_STOP_MS)
       Scope.close(handle.scope, Exit.succeed(undefined))
       fileSystem.remove(handle.dataDir, { recursive: true })
     Note: Nanoclaw's container subprocesses are managed by
     OneCLI/Docker; killing the node process sends SIGTERM
     to nanoclaw, which is responsible for stopping its own
     Docker containers.
```

## OS Signal Propagation (`launchRuntimeFleetWithProcessSignals`)

```text
SIGINT or SIGTERM arrives at the Node.js process
  │
  ├─ handler() fires (installed via process.on):       fleet.ts → installProcessSignalHandlers
  │    if shutdownSignal.value !== null: return (once only)
  │    shutdownSignal.value = signal
  │    Effect.runFork(Fiber.interrupt(fiber))
  │
  ├─ Effect fiber interrupted
  │    → Effect.forEach aborts in-progress startFleetAgent
  │    → onExit finalizer:
  │         Exit.isInterrupted → teardownStartedAgents(startedAgents)
  │         (all successfully-started agents torn down)
  │
  └─ fiber observer fires:                             fleet.ts → observeFleetLaunchFiber
       if shutdownSignal.value !== null && Exit.isInterrupted:
         resume(RuntimeFleetStartupInterrupted { signal })
       else:
         resume(Effect.failCause(exit.cause))
       cleanup(): process.off() for all registered handlers
```

## See Also

- [Fleet Launch](./02-fleet-launch.md)
- [Per-Adapter Spawn Details](./03-per-adapter-spawn.md)
- [Process State Machine](./07-process-state-machine.md)
