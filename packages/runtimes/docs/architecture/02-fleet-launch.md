# Fleet Launch Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Overview

`launchRuntimeFleet` launches N agents, by default sequentially
(`concurrency: 1`). `launchRuntimeFleetWithProcessSignals` wraps it with
OS-signal handlers.

```mermaid
flowchart TD
    FL["launchRuntimeFleet(options)\nfleet.ts → launchRuntimeFleet\nEffect.scoped(...)\nEffect.withSpan(&quot;launchRuntimeFleet&quot;)\n\nstartedAgents: StartedRuntimeAgent[]\n\nEffect.forEach(options.agents, startFleetAgent,\n  { concurrency: options.concurrency ?? 1 })"]

    subgraph Sequential["Sequential by default (concurrency: 1)"]
        A0["startFleetAgent — Agent 0\nfleet.ts → startFleetAgent"]
        A1["startFleetAgent — Agent 1\n(starts after 0 succeeds)"]
        AN["startFleetAgent — Agent N\n(starts after 1 succeeds)"]
        A0 --> A1 --> AN
    end

    FL --> Sequential

    Sequential -->|"onExit finalizer\n(Exit.isSuccess → void\nelse → teardownStartedAgents\nin REVERSE insertion order\nfleet.ts → teardownStartedAgents)"| OUTCOME

    OUTCOME{"outcome?"}

    OUTCOME -->|"ONE agent fails"| FAIL["startPendingRuntimeAgent fails\nwith RuntimeLaunchFailed\nEffect.forEach short-circuits\nonExit finalizer tears down all\nstartedAgents so far\nCaller receives first error"]

    OUTCOME -->|"All agents succeed"| SUCCESS["toRuntimeFleet(started)\nfleet.ts → toRuntimeFleet\n→ RuntimeFleet {\n  agents: [{ name, agentId }, ...],\n  stopAll: () =&gt; teardownStartedAgents(started),\n  getLogs: (name) =&gt; runtime.getLogs(0).text\n}"]
```

## Signal-Handler Variant

```mermaid
flowchart TD
    LRFPS["launchRuntimeFleetWithProcessSignals(options)\nfleet.ts → launchRuntimeFleetWithProcessSignals"]
    FORK["Effect.runFork(launchRuntimeFleet(options)) → fiber"]
    SIGNALS["installProcessSignalHandlers(\n  signals ?? [&quot;SIGINT&quot;, &quot;SIGTERM&quot;],\n  shutdownSignal, fiber\n)\nfleet.ts → installProcessSignalHandlers\n\nEach signal: process.on(signal, handler)\nFirst signal to fire:\n  shutdownSignal.value = signal\n  Effect.runFork(Fiber.interrupt(fiber))"]
    OBS["observeFleetLaunchFiber(fiber, ...)\nfleet.ts → observeFleetLaunchFiber\n\nfiber.addObserver(exit =&gt; {\n  cleanup()  ← process.off() all handlers\n  ...route by exit shape (see below)\n})"]
    OK["Exit.isSuccess\n→ resume(Effect.succeed(fleet))"]
    INT["shutdownSignal.value !== null &amp;&amp; interrupted\n→ resume(interruptedStartup(signal))\nRuntimeFleetStartupInterrupted { signal }\nfleet.ts → RuntimeFleetStartupInterrupted"]
    ERR["else\n→ resume(Effect.failCause(exit.cause))"]
    CLEANUP["Returns Effect.async cleanup:\ncleanup() + Fiber.interrupt(fiber)\n(Effect-level cancellation of outer effect)"]

    LRFPS --> FORK --> SIGNALS --> OBS
    OBS --> OK
    OBS --> INT
    OBS --> ERR
    LRFPS --> CLEANUP
```

`RuntimeFleetStartupInterrupted` is the only error type that is **not** in
`errors.ts`; it is local to `fleet.ts` because it only arises in the signals
variant and carries the interrupting `Signal` value.

## See Also

- [Single-Runtime Startup](./01-single-runtime-startup.md)
- [Shutdown Propagation](./05-shutdown-propagation.md)
- [Error Matrix](./06-error-matrix.md)
