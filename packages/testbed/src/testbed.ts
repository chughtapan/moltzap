/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Data, Effect, Exit, Fiber } from "effect";
import type { Signal } from "@effect/platform/CommandExecutor";
import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import {
  RuntimeExitedBeforeReady,
  RuntimeReadyTimedOut,
  type RuntimeLaunchFailed,
} from "./errors.js";
import {
  NanoclawAdapter,
  type NanoclawAdapterOptions,
} from "./nanoclaw-adapter.js";
import {
  createOpenClawAdapter,
  type OpenClawAdapterOptions,
} from "./openclaw-adapter.js";
import {
  AgentName,
  ServerUrl,
  type Runtime,
  type RuntimeServerHandle,
  type SpawnInput,
  type WorkspaceFile,
} from "./runtime.js";

const LOG_START_OFFSET = 0;

export interface TestbedAgentSpec {
  readonly agentName: string;
  readonly apiKey: AgentKey;
  readonly agentId: AgentId;
  readonly serverUrl: string;
  readonly workspaceFiles?: ReadonlyArray<WorkspaceFile>;
  readonly modelId?: string;
}

interface RuntimeStartOptionsBase {
  readonly server: RuntimeServerHandle;
  readonly agent: TestbedAgentSpec;
  readonly readyTimeoutMs: number;
}

type RuntimeSelection =
  | {
      readonly kind: "openclaw";
      readonly openclaw?: Omit<OpenClawAdapterOptions, "server">;
      readonly nanoclaw?: never;
    }
  | {
      readonly kind: "nanoclaw";
      readonly nanoclaw?: Omit<NanoclawAdapterOptions, "server">;
      readonly openclaw?: never;
    };

export type RuntimeKind = RuntimeSelection["kind"];

export type RuntimeStartOptions = RuntimeStartOptionsBase & RuntimeSelection;

interface TestbedLaunchOptionsBase {
  readonly server: RuntimeServerHandle;
  readonly agents: ReadonlyArray<TestbedAgentSpec>;
  readonly readyTimeoutMs: number;
  readonly concurrency?: number | "unbounded";
}

export type TestbedLaunchOptions = TestbedLaunchOptionsBase & RuntimeSelection;

export type TestbedProcessSignalOptions = TestbedLaunchOptions & {
  readonly signals?: ReadonlyArray<Signal>;
};

export interface TestbedAgent {
  readonly name: string;
  readonly agentId: AgentId;
}

export interface Testbed {
  readonly agents: ReadonlyArray<TestbedAgent>;
  stopAll(): Effect.Effect<void, never, never>;
  getLogs(name: string): string;
}

export class TestbedStartupInterrupted extends Data.TaggedError(
  "TestbedStartupInterrupted",
)<{
  readonly signal: Signal;
  readonly message: string;
}> {}

interface StartedRuntimeAgent {
  readonly spec: TestbedAgentSpec;
  readonly runtime: Runtime;
}

interface PendingRuntimeAgent {
  readonly runtime: Runtime;
  readonly releaseStartupCleanup: Effect.Effect<void, never, never>;
}

interface ProcessSignalHandler {
  readonly signal: Signal;
  readonly handler: () => void;
}

interface ShutdownSignalState {
  value: Signal | null;
}

class UnknownRuntimeAgent extends Data.TaggedError("UnknownRuntimeAgent")<{
  readonly agentName: string;
  readonly knownAgents: ReadonlyArray<string>;
  readonly message: string;
}> {}

function createRuntime(options: RuntimeStartOptions): Runtime {
  switch (options.kind) {
    case "openclaw":
      return createOpenClawAdapter({
        server: options.server,
        ...options.openclaw,
      });
    case "nanoclaw":
      return new NanoclawAdapter({
        server: options.server,
        ...options.nanoclaw,
      });
  }
}

function toSpawnInput(agent: TestbedAgentSpec): SpawnInput {
  return {
    agentName: AgentName(agent.agentName),
    apiKey: agent.apiKey,
    agentId: agent.agentId,
    serverUrl: ServerUrl(agent.serverUrl),
    ...(agent.workspaceFiles !== undefined
      ? { workspaceFiles: agent.workspaceFiles }
      : {}),
    ...(agent.modelId !== undefined ? { modelId: agent.modelId } : {}),
  };
}

/**
 * Tear down every started agent in REVERSE insertion order. Last
 * spawned is torn down first so cleanup mirrors startup.
 *
 * Per-adapter teardown does (in order): SIGTERM a running process tree;
 * SIGKILL descendants when the leader exits or the grace window lapses;
 * close the process Scope; recursively remove the temp state-dir.
 *
 * - OpenClaw: `OPENCLAW_TERM_WAIT_MS = 10_000`, `OPENCLAW_KILL_WAIT_MS = 5_000`.
 * - Nanoclaw: signals the runtime child, closes its process scope, then
 *   removes the isolated runtime directory.
 */
function teardownStartedAgents(
  startedAgents: ReadonlyArray<StartedRuntimeAgent>,
): Effect.Effect<void, never, never> {
  return Effect.forEach(
    [...startedAgents].reverse(),
    (startedAgent) => startedAgent.runtime.teardown(),
    { concurrency: 1, discard: true },
  );
}

function runtimeStartOptionsForAgent(
  options: TestbedLaunchOptions,
  agent: TestbedAgentSpec,
): RuntimeStartOptions {
  const common = {
    server: options.server,
    agent,
    readyTimeoutMs: options.readyTimeoutMs,
  };
  switch (options.kind) {
    case "openclaw":
      return {
        ...common,
        kind: "openclaw",
        openclaw: options.openclaw,
      };
    case "nanoclaw":
      return {
        ...common,
        kind: "nanoclaw",
        nanoclaw: options.nanoclaw,
      };
  }
}

function startTestbedAgent(
  options: TestbedLaunchOptions,
  startedAgents: StartedRuntimeAgent[],
  agent: TestbedAgentSpec,
) {
  return Effect.gen(function* () {
    const pending = yield* startPendingRuntimeAgent(
      runtimeStartOptionsForAgent(options, agent),
    );
    const startedAgent = {
      spec: agent,
      runtime: pending.runtime,
    } satisfies StartedRuntimeAgent;
    startedAgents.push(startedAgent);
    yield* pending.releaseStartupCleanup;
    return startedAgent;
  });
}

function logsForStartedAgent(
  started: ReadonlyArray<StartedRuntimeAgent>,
  name: string,
): string {
  const startedAgent = started.find(
    (candidate) => candidate.spec.agentName === name,
  );
  if (startedAgent !== undefined) {
    return startedAgent.runtime.getLogs(LOG_START_OFFSET).text;
  }

  const knownAgents = started.map((candidate) => candidate.spec.agentName);
  throw new UnknownRuntimeAgent({
    agentName: name,
    knownAgents,
    message: `Unknown runtime agent "${name}". Known agents: ${knownAgents.join(", ")}`,
  });
}

function toTestbed(started: ReadonlyArray<StartedRuntimeAgent>): Testbed {
  return {
    agents: started.map((startedAgent) => ({
      name: startedAgent.spec.agentName,
      agentId: startedAgent.spec.agentId,
    })),
    stopAll: () => teardownStartedAgents(started),
    getLogs: (name: string): string => logsForStartedAgent(started, name),
  };
}

function startPendingRuntimeAgent(options: RuntimeStartOptions) {
  const runtime = createRuntime(options);
  const spawnInput = toSpawnInput(options.agent);
  return Effect.gen(function* () {
    let cleanupArmed = true;
    const [closeStartupScope] = yield* Effect.withEarlyRelease(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          cleanupArmed ? runtime.teardown() : Effect.void,
        );
        yield* runtime.spawn(spawnInput);
      }),
    );
    const releaseStartupCleanup = Effect.uninterruptible(
      Effect.sync(() => {
        cleanupArmed = false;
      }).pipe(Effect.zipRight(closeStartupScope)),
    );

    const ready = yield* runtime.waitUntilReady(options.readyTimeoutMs);
    switch (ready._tag) {
      case "Ready":
        return {
          runtime,
          releaseStartupCleanup,
        } satisfies PendingRuntimeAgent;
      case "Timeout":
        return yield* Effect.fail(
          new RuntimeReadyTimedOut({
            agentName: options.agent.agentName,
            timeoutMs: ready.timeoutMs,
            message: `Runtime for agent "${options.agent.agentName}" did not become ready within ${String(ready.timeoutMs)}ms`,
          }),
        );
      case "ProcessExited":
        return yield* Effect.fail(
          new RuntimeExitedBeforeReady({
            agentName: options.agent.agentName,
            exitCode: ready.exitCode,
            stderr: ready.stderr,
            message: `Runtime for agent "${options.agent.agentName}" exited before readiness (exitCode=${String(ready.exitCode)})`,
          }),
        );
    }
  });
}

/**
 * Spawn one runtime agent, wait for ready, release the startup cleanup
 * scope and hand a long-lived `Runtime` back to the caller.
 *
 * ```mermaid
 * flowchart TD
 *   A["startRuntimeAgent(options)"]
 *   A --> B["Effect.scoped:<br>startPendingRuntimeAgent → PendingAgent"]
 *   B --> C[releaseStartupCleanup]
 *   C --> D["Runtime { teardown, getLogs }"]
 *   B -->|Spawn fails| E[SpawnFailed]
 *   B -->|Process exits early| F[RuntimeExitedBeforeReady]
 *   B -->|Ready signal times out| G[RuntimeReadyTimedOut]
 * ```
 *
 * Error channel is the union `RuntimeLaunchFailed` of the three
 * shapes above. Sibling: {@link launchTestbed} for multi-agent
 * coordinated startup.
 * @failure SpawnFailed when the child process cannot be started (exec error, bad binary, port allocation failure, state-dir error)
 * @failure RuntimeReadyTimedOut when `waitUntilReady` exceeds `readyTimeoutMs`
 * @failure RuntimeExitedBeforeReady when the process exits before signaling ready (inspect `stderr`)
 */
export function startRuntimeAgent(
  options: RuntimeStartOptions,
): Effect.Effect<Runtime, RuntimeLaunchFailed, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* startPendingRuntimeAgent(options);
      yield* pending.releaseStartupCleanup;
      return pending.runtime;
    }),
  ).pipe(Effect.withSpan("startRuntimeAgent"));
}

/**
 * Launch a testbed of N agents (sequentially by default; concurrency is
 * opt-in), tearing down all already-started agents if any one fails.
 *
 * ```mermaid
 * flowchart TD
 *   FL["launchTestbed(options)<br>Effect.scoped, withSpan"]
 *   FL --> SEQ["Effect.forEach(options.agents, startTestbedAgent,<br>{ concurrency: options.concurrency ?? 1 })"]
 *   SEQ -->|One fails| TD["onExit: teardownStartedAgents<br>in REVERSE insertion order"]
 *   SEQ -->|All succeed| RF["toTestbed(started)<br>→ Testbed { agents, stopAll, getLogs }"]
 * ```
 *
 * Sibling: {@link launchTestbedWithProcessSignals} adds SIGINT
 * / SIGTERM handlers so Ctrl-C during startup interrupts cleanly via
 * `TestbedStartupInterrupted`.
 */
export function launchTestbed(
  options: TestbedLaunchOptions,
): Effect.Effect<Testbed, RuntimeLaunchFailed, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const startedAgents: StartedRuntimeAgent[] = [];
      const started = yield* Effect.forEach(
        options.agents,
        (agent) => startTestbedAgent(options, startedAgents, agent),
        {
          concurrency: options.concurrency ?? 1,
        },
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : teardownStartedAgents(startedAgents),
        ),
      );
      return toTestbed(started);
    }),
  ).pipe(Effect.withSpan("launchTestbed"));
}

function installProcessSignalHandlers(
  signals: ReadonlyArray<Signal>,
  state: ShutdownSignalState,
  fiber: Fiber.RuntimeFiber<Testbed, RuntimeLaunchFailed>,
): ReadonlyArray<ProcessSignalHandler> {
  return signals.map((signal) => {
    const handler = (): void => {
      if (state.value !== null) {
        return;
      }
      state.value = signal;
      Effect.runFork(Fiber.interrupt(fiber));
    };
    process.on(signal, handler);
    return { signal, handler };
  });
}

function cleanupProcessSignalHandlers(
  handlers: ReadonlyArray<ProcessSignalHandler>,
): void {
  for (const { signal, handler } of handlers) {
    process.off(signal, handler);
  }
}

function observeTestbedLaunchFiber(
  fiber: Fiber.RuntimeFiber<Testbed, RuntimeLaunchFailed>,
  state: ShutdownSignalState,
  cleanup: () => void,
  resume: (
    effect: Effect.Effect<
      Testbed,
      RuntimeLaunchFailed | TestbedStartupInterrupted
    >,
  ) => void,
): void {
  fiber.addObserver((exit) => {
    cleanup();
    if (Exit.isSuccess(exit)) {
      resume(Effect.succeed(exit.value));
      return;
    }
    if (state.value !== null && Exit.isInterrupted(exit)) {
      resume(interruptedStartup(state.value));
      return;
    }
    resume(Effect.failCause(exit.cause));
  });
}

function interruptedStartup(signal: Signal) {
  return Effect.fail(
    new TestbedStartupInterrupted({
      signal,
      message: `Testbed startup interrupted by ${signal}`,
    }),
  );
}

/**
 * Wraps {@link launchTestbed} with OS-signal handlers so user Ctrl-C
 * during startup interrupts cleanly instead of half-launching a testbed.
 *
 * ```mermaid
 * flowchart TD
 *   LRFPS["launchTestbedWithProcessSignals(options)"]
 *   LRFPS --> FORK["Effect.runFork(launchTestbed) → fiber"]
 *   FORK --> SIGS["installProcessSignalHandlers<br>(SIGINT, SIGTERM by default)<br>first signal: shutdownSignal.value = signal<br>Fiber.interrupt(fiber)"]
 *   SIGS --> OBS["observeTestbedLaunchFiber<br>routes by exit shape"]
 *   LRFPS -->|caller interruption| CANCEL["canceler removes handlers<br>and awaits Fiber.interrupt(fiber)"]
 *   CANCEL --> CLEAN["launchTestbed finalizers<br>finish runtime teardown"]
 *   OBS -->|Success| OK["resume(Effect.succeed(testbed))"]
 *   OBS -->|Interrupted via signal| INT["resume(interruptedStartup(signal))<br>→ TestbedStartupInterrupted"]
 *   OBS -->|Other failure| ERR["resume(Effect.failCause(...))"]
 * ```
 * @failure TestbedStartupInterrupted when a signal arrives during testbed startup
 */
export function launchTestbedWithProcessSignals(
  options: TestbedProcessSignalOptions,
): Effect.Effect<
  Testbed,
  RuntimeLaunchFailed | TestbedStartupInterrupted,
  never
> {
  const signals = options.signals ?? ["SIGINT", "SIGTERM"];
  return Effect.async<Testbed, RuntimeLaunchFailed | TestbedStartupInterrupted>(
    (resume) => {
      const fiber = Effect.runFork(launchTestbed(options));
      const shutdownSignal: ShutdownSignalState = { value: null };
      const handlers = installProcessSignalHandlers(
        signals,
        shutdownSignal,
        fiber,
      );
      const cleanup = (): void => {
        cleanupProcessSignalHandlers(handlers);
      };

      observeTestbedLaunchFiber(fiber, shutdownSignal, cleanup, resume);

      return Effect.sync(cleanup).pipe(
        Effect.zipRight(Fiber.interrupt(fiber)),
        Effect.asVoid,
      );
    },
  );
}
