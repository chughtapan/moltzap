# Error Matrix

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

All typed errors in `errors.ts` and `fleet.ts`:

| Error `_tag` | File | Raised by | Fields | Typical caller action |
|---|---|---|---|---|
| `SpawnFailed` | `errors.ts` | `Runtime.spawn()` in all three adapters when the child process cannot be started (exec error, bad binary, port allocation failure, state-dir error) | `agentName`, `cause: Error`, `message` | Surface to caller; no retry — binary or config is wrong |
| `RuntimeReadyTimedOut` | `errors.ts` | `startPendingRuntimeAgent` when `waitUntilReady` returns `Timeout` | `agentName`, `timeoutMs`, `message` | Increase `readyTimeoutMs`, or inspect `runtime.getLogs(0)` for the subprocess output |
| `RuntimeExitedBeforeReady` | `errors.ts` | `startPendingRuntimeAgent` when `waitUntilReady` returns `ProcessExited` | `agentName`, `exitCode: number \| null`, `stderr`, `message` | Inspect `stderr` (full accumulated stdout+stderr at exit); check binary auth config |
| `RuntimeFleetStartupInterrupted` | `fleet.ts` | `launchRuntimeFleetWithProcessSignals` when a signal arrives during fleet startup | `signal: Signal`, `message` | Expected on user Ctrl-C; log and exit cleanly |

`RuntimeLaunchFailed` (in `errors.ts`) is the union type
`SpawnFailed | RuntimeReadyTimedOut | RuntimeExitedBeforeReady` — it is the
error channel of both `startRuntimeAgent` and `launchRuntimeFleet`.

## See Also

- [Single-Runtime Startup](./single-runtime-startup.md)
- [Fleet Launch](./fleet-launch.md)
- [Process State Machine](./process-state-machine.md)
