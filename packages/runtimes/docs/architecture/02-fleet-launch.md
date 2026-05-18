# Fleet Launch Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Overview

`launchRuntimeFleet` launches N agents, by default sequentially
(`concurrency: 1`). `launchRuntimeFleetWithProcessSignals` wraps it with
OS-signal handlers.

```text
                    launchRuntimeFleet(options)              fleet.ts → launchRuntimeFleet
                      Effect.scoped(...)
                      Effect.withSpan("launchRuntimeFleet")
                           │
                           │  startedAgents: StartedRuntimeAgent[]
                           │
                           ▼
                    Effect.forEach(options.agents, startFleetAgent,
                      { concurrency: options.concurrency ?? 1 })

              ┌────────────────────────────────────────────────────────┐
              │   Agent 0           Agent 1           Agent N          │
              │  startFleetAgent   startFleetAgent   startFleetAgent   │ fleet.ts → startFleetAgent
              │   (sequential by   (starts after 0   (starts after 1  │
              │    default)         succeeds)          succeeds)        │
              └────────────────────────────────────────────────────────┘
                           │
                 .pipe(Effect.onExit(exit =>
                   Exit.isSuccess(exit) ? void
                   : teardownStartedAgents(startedAgents)
                 ))
                 Teardown on failure is sequential in REVERSE
                 insertion order.                         fleet.ts → teardownStartedAgents

              ┌─ ONE agent fails ─────────────────────────────────────┐
              │  startPendingRuntimeAgent fails with RuntimeLaunchFailed│
              │  Effect.forEach short-circuits                          │
              │  onExit finalizer tears down all startedAgents so far  │
              │  Caller receives the first RuntimeLaunchFailed error    │
              └────────────────────────────────────────────────────────┘

              ┌─ All agents succeed ───────────────────────────────────┐
              │  toRuntimeFleet(started) → RuntimeFleet {              │ fleet.ts → toRuntimeFleet
              │    agents: [{ name, agentId }, ...],                   │
              │    stopAll: () => teardownStartedAgents(started),      │
              │    getLogs: (name) => runtime.getLogs(0).text          │
              │  }                                                      │
              └────────────────────────────────────────────────────────┘
```

## Signal-Handler Variant

```text
launchRuntimeFleetWithProcessSignals(options)               fleet.ts → launchRuntimeFleetWithProcessSignals
  │
  ├─ Effect.runFork(launchRuntimeFleet(options)) → fiber
  │
  ├─ installProcessSignalHandlers(                          fleet.ts → installProcessSignalHandlers
  │    signals ?? ["SIGINT","SIGTERM"],
  │    shutdownSignal,
  │    fiber
  │  )
  │   Each signal installs process.on(signal, handler)
  │   First signal to fire:
  │     shutdownSignal.value = signal
  │     Effect.runFork(Fiber.interrupt(fiber))
  │
  ├─ observeFleetLaunchFiber(fiber, ...)                    fleet.ts → observeFleetLaunchFiber
  │   fiber.addObserver(exit => {
  │     cleanup()  ← process.off() for all handlers
  │     if Exit.isSuccess → resume(Effect.succeed(fleet))
  │     if shutdownSignal.value !== null && interrupted
  │       → resume(interruptedStartup(signal))
  │         RuntimeFleetStartupInterrupted { signal }       fleet.ts → RuntimeFleetStartupInterrupted
  │     else
  │       → resume(Effect.failCause(exit.cause))
  │   })
  │
  └─ Returns Effect.async cleanup:
       cleanup() + Fiber.interrupt(fiber)
       (for Effect-level cancellation of the outer effect)
```

`RuntimeFleetStartupInterrupted` is the only error type that is **not** in
`errors.ts`; it is local to `fleet.ts` because it only arises in the signals
variant and carries the interrupting `Signal` value.

## See Also

- [Single-Runtime Startup](./01-single-runtime-startup.md)
- [Shutdown Propagation](./05-shutdown-propagation.md)
- [Error Matrix](./06-error-matrix.md)
