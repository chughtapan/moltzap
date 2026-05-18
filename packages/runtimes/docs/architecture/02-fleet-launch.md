# Fleet Launch Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Overview

`launchRuntimeFleet` launches N agents, by default sequentially
(`concurrency: 1`). `launchRuntimeFleetWithProcessSignals` wraps it with
OS-signal handlers.

```mermaid
flowchart TD
    FL["launchRuntimeFleet(options)<br>fleet.ts → launchRuntimeFleet<br>Effect.scoped(...)<br>Effect.withSpan(&quot;launchRuntimeFleet&quot;)<br><br>startedAgents: StartedRuntimeAgent[]<br><br>Effect.forEach(options.agents, startFleetAgent,<br>  { concurrency: options.concurrency ?? 1 })"]

    subgraph Sequential["Sequential by default (concurrency: 1)"]
        A0["startFleetAgent — Agent 0<br>fleet.ts → startFleetAgent"]
        A1["startFleetAgent — Agent 1<br>(starts after 0 succeeds)"]
        AN["startFleetAgent — Agent N<br>(starts after 1 succeeds)"]
        A0 --> A1 --> AN
    end

    FL --> Sequential

    Sequential -->|"onExit finalizer<br>(Exit.isSuccess → void<br>else → teardownStartedAgents<br>in REVERSE insertion order<br>fleet.ts → teardownStartedAgents)"| OUTCOME

    OUTCOME{"outcome?"}

    OUTCOME -->|"ONE agent fails"| FAIL["startPendingRuntimeAgent fails<br>with RuntimeLaunchFailed<br>Effect.forEach short-circuits<br>onExit finalizer tears down all<br>startedAgents so far<br>Caller receives first error"]

    OUTCOME -->|"All agents succeed"| SUCCESS["toRuntimeFleet(started)<br>fleet.ts → toRuntimeFleet<br>→ RuntimeFleet {<br>  agents: [{ name, agentId }, ...],<br>  stopAll: () =&gt; teardownStartedAgents(started),<br>  getLogs: (name) =&gt; runtime.getLogs(0).text<br>}"]
```

## Signal-Handler Variant

```mermaid
flowchart TD
    LRFPS["launchRuntimeFleetWithProcessSignals(options)<br>fleet.ts → launchRuntimeFleetWithProcessSignals"]
    FORK["Effect.runFork(launchRuntimeFleet(options)) → fiber"]
    SIGNALS["installProcessSignalHandlers(<br>  signals ?? [&quot;SIGINT&quot;, &quot;SIGTERM&quot;],<br>  shutdownSignal, fiber<br>)<br>fleet.ts → installProcessSignalHandlers<br><br>Each signal: process.on(signal, handler)<br>First signal to fire:<br>  shutdownSignal.value = signal<br>  Effect.runFork(Fiber.interrupt(fiber))"]
    OBS["observeFleetLaunchFiber(fiber, ...)<br>fleet.ts → observeFleetLaunchFiber<br><br>fiber.addObserver(exit =&gt; {<br>  cleanup()  ← process.off() all handlers<br>  ...route by exit shape (see below)<br>})"]
    OK["Exit.isSuccess<br>→ resume(Effect.succeed(fleet))"]
    INT["shutdownSignal.value !== null &amp;&amp; interrupted<br>→ resume(interruptedStartup(signal))<br>RuntimeFleetStartupInterrupted { signal }<br>fleet.ts → RuntimeFleetStartupInterrupted"]
    ERR["else<br>→ resume(Effect.failCause(exit.cause))"]
    CLEANUP["Returns Effect.async cleanup:<br>cleanup() + Fiber.interrupt(fiber)<br>(Effect-level cancellation of outer effect)"]

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
