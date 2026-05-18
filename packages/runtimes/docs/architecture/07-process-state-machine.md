# Per-Process State Machine

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Overview

Each adapter instance tracks a single logical process lifecycle through an
internal `AdapterState` object with a `tornDown` boolean guard.

```text
States:

  NOT_STARTED
    state = null
    Initial state after adapter construction.
    waitUntilReady() returns Ready immediately (no-op guard).
    getLogs() returns { text: "", nextOffset: 0 }.
    teardown() is a no-op.

  SPAWNED
    state = { process, stateDir, logBuffer, tornDown: false }
    Entered when Runtime.spawn() completes successfully.
    exitFiber is running; stdout/stderr fibers are running.
    waitUntilReady() races server auth vs. process exit poll.

  READY
    Same AdapterState shape as SPAWNED; no distinct field.
    waitUntilReady() returned ReadyOutcome { _tag: "Ready" }.
    Caller now owns the Runtime; teardown() must be called
    explicitly (or via fleet.stopAll()).

  TORN_DOWN
    state.tornDown = true  (set atomically inside doTeardown)
    Process sent SIGTERM/SIGKILL; scope closed; stateDir removed.
    teardown() is idempotent — subsequent calls return void
    immediately (the tornDown guard short-circuits at entry).

Transitions:

  NOT_STARTED ──spawn() ok──▶ SPAWNED
  NOT_STARTED ──spawn() err──▶ NOT_STARTED (state remains null;
                                SpawnFailed propagates to caller)
  SPAWNED ──Ready outcome──▶ READY
  SPAWNED ──Timeout outcome──▶ TORN_DOWN  (teardown called internally
                                            before RuntimeReadyTimedOut fail)
  SPAWNED ──ProcessExited───▶ TORN_DOWN  (teardown called internally
                                           before RuntimeExitedBeforeReady fail)
  READY ──teardown()──▶ TORN_DOWN
  TORN_DOWN ──teardown()──▶ TORN_DOWN  (no-op, idempotent)
```

## See Also

- [Single-Runtime Startup](./01-single-runtime-startup.md)
- [Shutdown Propagation](./05-shutdown-propagation.md)
- [Error Matrix](./06-error-matrix.md)
