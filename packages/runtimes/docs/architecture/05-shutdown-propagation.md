# Shutdown Propagation

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Caller-Initiated via `RuntimeFleet.stopAll()`

```mermaid
flowchart TD
    SA["fleet.stopAll()"]
    TD["teardownStartedAgents(startedAgents)\nfleet.ts → teardownStartedAgents\nEffect.forEach([...startedAgents].reverse(),\n  agent =&gt; agent.runtime.teardown(),\n  { concurrency: 1 })\nReverse order = last-spawned torn down first"]

    SA --> TD
```

## OpenClaw Teardown (`openclaw-adapter.ts → OpenClawAdapter.doTeardown`)

```mermaid
flowchart TD
    OCT["OpenClawAdapter.doTeardown()\nopenclaw-adapter.ts → OpenClawAdapter.doTeardown"]
    OCT1["1. Effect.sync:\n   if state === null || state.tornDown → return null\n   state.tornDown = true\n   capture { process, stateDir }"]
    OCT2{"2. pollExitCode(proc)\nFiber.poll(exitFiber)"}
    OCT2A["Option.Some\n→ process already exited, skip signal"]
    OCT2B["Option.None →\nwaitAfterSigterm(proc)\nopenclaw-adapter.ts → waitAfterSigterm\nproc.kill(&quot;SIGTERM&quot;)\ntimeout(OPENCLAW_TERM_WAIT_MS = 10 000 ms)"]
    OCT2C{"still running?"}
    OCT2D["proc.kill(&quot;SIGKILL&quot;)\ntimeout(OPENCLAW_KILL_WAIT_MS = 5 000 ms)"]
    OCT3["3. Scope.close(proc.scope, Exit.succeed(undefined))\nRuns Command.start kill finalizer +\nstdout/stderr fiber finalizers"]
    OCT4["4. fileSystem.remove(stateDir, { recursive: true })\nRemoves openclaw.json, workspace/,\nlogs/, plugin symlinks\nErrors caught and logged as warnings"]

    OCT --> OCT1 --> OCT2
    OCT2 -->|"Option.Some"| OCT2A
    OCT2 -->|"Option.None"| OCT2B --> OCT2C
    OCT2C -->|"yes"| OCT2D
    OCT2C -->|"no"| OCT3
    OCT2A --> OCT3
    OCT2D --> OCT3
    OCT3 --> OCT4
```

## ClaudeCode Teardown (`claude-code-adapter.ts → ClaudeCodeAdapter.doTeardown`)

```mermaid
flowchart TD
    CCT["ClaudeCodeAdapter.doTeardown()\nclaude-code-adapter.ts → ClaudeCodeAdapter.doTeardown"]
    CCT1["1. Guard: if !state || state.tornDown → return void\n   state.tornDown = true\n   capture { process: proc, stateDir }"]
    CCT2{"2. pollExitCode(proc)\nFiber.poll(proc.exitFiber)"}
    CCT2A["Option.Some → skip signal (already exited)"]
    CCT2B["Option.None →\nwaitAfterSigterm(proc)\nclaude-code-adapter.ts → waitAfterSigterm\nproc.kill(&quot;SIGTERM&quot;)\ntimeout(TERM_WAIT_MS = 10 000 ms)"]
    CCT2C{"still running?"}
    CCT2D["proc.kill(&quot;SIGKILL&quot;)\ntimeout(TERM_WAIT_MS = 10 000 ms)"]
    CCT3["3. Scope.close(proc.scope, Exit.succeed(undefined))\nNote: No explicit process-group kill —\nSIGTERM on claude propagates to cc-channel\n(its MCP child) naturally via process hierarchy"]
    CCT4["4. fileSystem.remove(stateDir, { recursive: true })\nErrors caught and logged as warnings"]

    CCT --> CCT1 --> CCT2
    CCT2 -->|"Option.Some"| CCT2A
    CCT2 -->|"Option.None"| CCT2B --> CCT2C
    CCT2C -->|"yes"| CCT2D
    CCT2C -->|"no"| CCT3
    CCT2A --> CCT3
    CCT2D --> CCT3
    CCT3 --> CCT4
```

## Nanoclaw Teardown (`nanoclaw-adapter.ts → NanoclawAdapter.doTeardown`)

```mermaid
flowchart TD
    NCT["NanoclawAdapter.doTeardown()\nnanoclaw-adapter.ts → NanoclawAdapter.doTeardown"]
    NCT1["1. Effect.sync:\n   if !state || state.tornDown → return null\n   state.tornDown = true\n   return state.handle"]
    NCT2["2. stopNanoclawRuntimeEffect(handle)\nnanoclaw-process.ts → stopNanoclawRuntimeEffect"]
    NCT2A{"proc.isRunning?"}
    NCT2B["killProcessAndWait(proc, &quot;SIGTERM&quot;,\nGRACEFUL_STOP_MS = 3 000 ms)\nnanoclaw-process.ts → killProcessAndWait"]
    NCT2C{"still running?"}
    NCT2D["killProcessAndWait(proc, &quot;SIGKILL&quot;,\nGRACEFUL_STOP_MS)"]
    NCT3["Scope.close(handle.scope, Exit.succeed(undefined))\nfileSystem.remove(handle.dataDir, { recursive: true })\nNote: Nanoclaw's container subprocesses managed by\nOneCLI/Docker; killing node sends SIGTERM to nanoclaw,\nwhich stops its own Docker containers"]

    NCT --> NCT1 --> NCT2 --> NCT2A
    NCT2A -->|"true"| NCT2B --> NCT2C
    NCT2C -->|"yes"| NCT2D --> NCT3
    NCT2C -->|"no"| NCT3
    NCT2A -->|"false (not running)"| NCT3
```

## OS Signal Propagation (`launchRuntimeFleetWithProcessSignals`)

```mermaid
flowchart TD
    SIG["SIGINT or SIGTERM\narrives at Node.js process"]
    HANDLER["handler() fires\nfleet.ts → installProcessSignalHandlers\nif shutdownSignal.value !== null: return (once only)\nshutdownSignal.value = signal\nEffect.runFork(Fiber.interrupt(fiber))"]
    FINT["Effect fiber interrupted\n→ Effect.forEach aborts in-progress startFleetAgent\n→ onExit finalizer:\n   Exit.isInterrupted → teardownStartedAgents(startedAgents)\n   (all successfully-started agents torn down)"]
    OBS["fiber observer fires\nfleet.ts → observeFleetLaunchFiber"]
    INT["shutdownSignal.value !== null &amp;&amp; Exit.isInterrupted:\nresume(RuntimeFleetStartupInterrupted { signal })"]
    ERR["else:\nresume(Effect.failCause(exit.cause))"]
    CLEAN["cleanup(): process.off() for all registered handlers"]

    SIG --> HANDLER --> FINT --> OBS
    OBS --> INT
    OBS --> ERR
    OBS --> CLEAN
```

## See Also

- [Fleet Launch](./02-fleet-launch.md)
- [Per-Adapter Spawn Details](./03-per-adapter-spawn.md)
- [Process State Machine](./07-process-state-machine.md)
