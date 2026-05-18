# Shutdown Propagation

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Caller-Initiated via `RuntimeFleet.stopAll()`

```mermaid
flowchart TD
    SA["fleet.stopAll()"]
    TD["teardownStartedAgents(startedAgents)<br>fleet.ts → teardownStartedAgents<br>Effect.forEach([...startedAgents].reverse(),<br>  agent =&gt; agent.runtime.teardown(),<br>  { concurrency: 1 })<br>Reverse order = last-spawned torn down first"]

    SA --> TD
```

## OpenClaw Teardown (`openclaw-adapter.ts → OpenClawAdapter.doTeardown`)

```mermaid
flowchart TD
    OCT["OpenClawAdapter.doTeardown()<br>openclaw-adapter.ts → OpenClawAdapter.doTeardown"]
    OCT1["1. Effect.sync:<br>   if state === null || state.tornDown → return null<br>   state.tornDown = true<br>   capture { process, stateDir }"]
    OCT2{"2. pollExitCode(proc)<br>Fiber.poll(exitFiber)"}
    OCT2A["Option.Some<br>→ process already exited, skip signal"]
    OCT2B["Option.None →<br>waitAfterSigterm(proc)<br>openclaw-adapter.ts → waitAfterSigterm<br>proc.kill(&quot;SIGTERM&quot;)<br>timeout(OPENCLAW_TERM_WAIT_MS = 10 000 ms)"]
    OCT2C{"still running?"}
    OCT2D["proc.kill(&quot;SIGKILL&quot;)<br>timeout(OPENCLAW_KILL_WAIT_MS = 5 000 ms)"]
    OCT3["3. Scope.close(proc.scope, Exit.succeed(undefined))<br>Runs Command.start kill finalizer +<br>stdout/stderr fiber finalizers"]
    OCT4["4. fileSystem.remove(stateDir, { recursive: true })<br>Removes openclaw.json, workspace/,<br>logs/, plugin symlinks<br>Errors caught and logged as warnings"]

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
    CCT["ClaudeCodeAdapter.doTeardown()<br>claude-code-adapter.ts → ClaudeCodeAdapter.doTeardown"]
    CCT1["1. Guard: if !state || state.tornDown → return void<br>   state.tornDown = true<br>   capture { process: proc, stateDir }"]
    CCT2{"2. pollExitCode(proc)<br>Fiber.poll(proc.exitFiber)"}
    CCT2A["Option.Some → skip signal (already exited)"]
    CCT2B["Option.None →<br>waitAfterSigterm(proc)<br>claude-code-adapter.ts → waitAfterSigterm<br>proc.kill(&quot;SIGTERM&quot;)<br>timeout(TERM_WAIT_MS = 10 000 ms)"]
    CCT2C{"still running?"}
    CCT2D["proc.kill(&quot;SIGKILL&quot;)<br>timeout(TERM_WAIT_MS = 10 000 ms)"]
    CCT3["3. Scope.close(proc.scope, Exit.succeed(undefined))<br>Note: No explicit process-group kill —<br>SIGTERM on claude propagates to cc-channel<br>(its MCP child) naturally via process hierarchy"]
    CCT4["4. fileSystem.remove(stateDir, { recursive: true })<br>Errors caught and logged as warnings"]

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
    NCT["NanoclawAdapter.doTeardown()<br>nanoclaw-adapter.ts → NanoclawAdapter.doTeardown"]
    NCT1["1. Effect.sync:<br>   if !state || state.tornDown → return null<br>   state.tornDown = true<br>   return state.handle"]
    NCT2["2. stopNanoclawRuntimeEffect(handle)<br>nanoclaw-process.ts → stopNanoclawRuntimeEffect"]
    NCT2A{"proc.isRunning?"}
    NCT2B["killProcessAndWait(proc, &quot;SIGTERM&quot;,<br>GRACEFUL_STOP_MS = 3 000 ms)<br>nanoclaw-process.ts → killProcessAndWait"]
    NCT2C{"still running?"}
    NCT2D["killProcessAndWait(proc, &quot;SIGKILL&quot;,<br>GRACEFUL_STOP_MS)"]
    NCT3["Scope.close(handle.scope, Exit.succeed(undefined))<br>fileSystem.remove(handle.dataDir, { recursive: true })<br>Note: Nanoclaw's container subprocesses managed by<br>OneCLI/Docker; killing node sends SIGTERM to nanoclaw,<br>which stops its own Docker containers"]

    NCT --> NCT1 --> NCT2 --> NCT2A
    NCT2A -->|"true"| NCT2B --> NCT2C
    NCT2C -->|"yes"| NCT2D --> NCT3
    NCT2C -->|"no"| NCT3
    NCT2A -->|"false (not running)"| NCT3
```

## OS Signal Propagation (`launchRuntimeFleetWithProcessSignals`)

```mermaid
flowchart TD
    SIG["SIGINT or SIGTERM<br>arrives at Node.js process"]
    HANDLER["handler() fires<br>fleet.ts → installProcessSignalHandlers<br>if shutdownSignal.value !== null: return (once only)<br>shutdownSignal.value = signal<br>Effect.runFork(Fiber.interrupt(fiber))"]
    FINT["Effect fiber interrupted<br>→ Effect.forEach aborts in-progress startFleetAgent<br>→ onExit finalizer:<br>   Exit.isInterrupted → teardownStartedAgents(startedAgents)<br>   (all successfully-started agents torn down)"]
    OBS["fiber observer fires<br>fleet.ts → observeFleetLaunchFiber"]
    INT["shutdownSignal.value !== null &amp;&amp; Exit.isInterrupted:<br>resume(RuntimeFleetStartupInterrupted { signal })"]
    ERR["else:<br>resume(Effect.failCause(exit.cause))"]
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
