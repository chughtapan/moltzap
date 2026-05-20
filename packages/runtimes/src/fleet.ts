import { Data, Effect, Exit, Fiber } from "effect";
import type { Signal } from "@effect/platform/CommandExecutor";
import {
  RuntimeExitedBeforeReady,
  RuntimeReadyTimedOut,
  type RuntimeLaunchFailed,
} from "./errors.js";
import {
  createWorkspaceClaudeCodeAdapter,
  type WorkspaceClaudeCodeAdapterInput,
} from "./claude-code-adapter.js";
import {
  NanoclawAdapter,
  type NanoclawAdapterDeps,
} from "./nanoclaw-adapter.js";
import {
  createWorkspaceOpenClawAdapter,
  type WorkspaceOpenClawAdapterInput,
} from "./openclaw-adapter.js";
import {
  AgentName,
  ApiKey,
  ServerUrl,
  type Runtime,
  type RuntimeServerHandle,
  type SpawnInput,
  type WorkspaceFile,
} from "./runtime.js";

export type RuntimeKind = "openclaw" | "nanoclaw" | "claude-code";

const LOG_START_OFFSET = 0;

export interface RuntimeAgentSpec {
  readonly agentName: string;
  readonly apiKey: string;
  readonly agentId: string;
  readonly serverUrl: string;
  readonly workspaceFiles?: ReadonlyArray<WorkspaceFile>;
  readonly modelId?: string;
}

export interface RuntimeStartOptions {
  readonly kind: RuntimeKind;
  readonly server: RuntimeServerHandle;
  readonly agent: RuntimeAgentSpec;
  readonly readyTimeoutMs: number;
  readonly openclaw?: Omit<WorkspaceOpenClawAdapterInput, "server">;
  readonly nanoclaw?: Omit<NanoclawAdapterDeps, "server">;
  readonly claudeCode?: Omit<WorkspaceClaudeCodeAdapterInput, "server">;
}

export interface RuntimeFleetLaunchOptions {
  readonly kind: RuntimeKind;
  readonly server: RuntimeServerHandle;
  readonly agents: ReadonlyArray<RuntimeAgentSpec>;
  readonly readyTimeoutMs: number;
  readonly concurrency?: number | "unbounded";
  readonly openclaw?: Omit<WorkspaceOpenClawAdapterInput, "server">;
  readonly nanoclaw?: Omit<NanoclawAdapterDeps, "server">;
  readonly claudeCode?: Omit<WorkspaceClaudeCodeAdapterInput, "server">;
}

export interface RuntimeFleetProcessSignalOptions
  extends RuntimeFleetLaunchOptions {
  readonly signals?: ReadonlyArray<Signal>;
}

export interface RuntimeFleetAgent {
  readonly name: string;
  readonly agentId: string;
}

export interface RuntimeFleet {
  readonly agents: ReadonlyArray<RuntimeFleetAgent>;
  stopAll(): Effect.Effect<void, never, never>;
  getLogs(name: string): string;
}

export class RuntimeFleetStartupInterrupted extends Data.TaggedError(
  "RuntimeFleetStartupInterrupted",
)<{
  readonly signal: Signal;
  readonly message: string;
}> {}

interface StartedRuntimeAgent {
  readonly spec: RuntimeAgentSpec;
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
      return createWorkspaceOpenClawAdapter({
        server: options.server,
        ...options.openclaw,
      });
    case "nanoclaw":
      return new NanoclawAdapter({
        server: options.server,
        ...options.nanoclaw,
      });
    case "claude-code":
      return createWorkspaceClaudeCodeAdapter({
        server: options.server,
        ...options.claudeCode,
      });
  }
}

function toSpawnInput(agent: RuntimeAgentSpec): SpawnInput {
  return {
    agentName: AgentName(agent.agentName),
    apiKey: ApiKey(agent.apiKey),
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
 * Per-adapter teardown does (in order): poll exit; if not exited,
 * SIGTERM with timeout; if still running, SIGKILL with timeout;
 * close the process Scope; recursively remove the temp state-dir.
 *
 * - OpenClaw: `OPENCLAW_TERM_WAIT_MS = 10_000`, `OPENCLAW_KILL_WAIT_MS = 5_000`.
 * - ClaudeCode: same shape, single 10s wait window; no explicit
 *   process-group kill because SIGTERM on claude propagates to the
 *   cc-channel MCP child naturally via the process hierarchy.
 * - Nanoclaw: stops the runtime via OneCLI gateway, then removes
 *   data dir.
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
  options: RuntimeFleetLaunchOptions,
  agent: RuntimeAgentSpec,
): RuntimeStartOptions {
  return {
    kind: options.kind,
    server: options.server,
    agent,
    readyTimeoutMs: options.readyTimeoutMs,
    ...(options.openclaw !== undefined ? { openclaw: options.openclaw } : {}),
    ...(options.nanoclaw !== undefined ? { nanoclaw: options.nanoclaw } : {}),
    ...(options.claudeCode !== undefined
      ? { claudeCode: options.claudeCode }
      : {}),
  };
}

function startFleetAgent(
  options: RuntimeFleetLaunchOptions,
  startedAgents: StartedRuntimeAgent[],
  agent: RuntimeAgentSpec,
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

function toRuntimeFleet(
  started: ReadonlyArray<StartedRuntimeAgent>,
): RuntimeFleet {
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
 *   C --> D["Runtime { stop, getLogs }"]
 *   B -->|Spawn fails| E[SpawnFailed]
 *   B -->|Process exits early| F[RuntimeExitedBeforeReady]
 *   B -->|Ready signal times out| G[RuntimeReadyTimedOut]
 * ```
 *
 * Error channel is the union `RuntimeLaunchFailed` of the three
 * shapes above. Sibling: {@link launchRuntimeFleet} for multi-agent
 * coordinated startup.
 *
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
 * Launch N agents (sequentially by default; concurrency is opt-in),
 * tearing down all already-started agents if any one fails.
 *
 * ```mermaid
 * flowchart TD
 *   FL["launchRuntimeFleet(options)<br>Effect.scoped, withSpan"]
 *   FL --> SEQ["Effect.forEach(options.agents, startFleetAgent,<br>{ concurrency: options.concurrency ?? 1 })"]
 *   SEQ -->|One fails| TD["onExit: teardownStartedAgents<br>in REVERSE insertion order"]
 *   SEQ -->|All succeed| RF["toRuntimeFleet(started)<br>→ RuntimeFleet { agents, stopAll, getLogs }"]
 * ```
 *
 * Sibling: {@link launchRuntimeFleetWithProcessSignals} adds SIGINT
 * / SIGTERM handlers so Ctrl-C during startup interrupts cleanly via
 * `RuntimeFleetStartupInterrupted`.
 */
export function launchRuntimeFleet(
  options: RuntimeFleetLaunchOptions,
): Effect.Effect<RuntimeFleet, RuntimeLaunchFailed, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const startedAgents: StartedRuntimeAgent[] = [];
      const started = yield* Effect.forEach(
        options.agents,
        (agent) => startFleetAgent(options, startedAgents, agent),
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
      return toRuntimeFleet(started);
    }),
  ).pipe(Effect.withSpan("launchRuntimeFleet"));
}

function installProcessSignalHandlers(
  signals: ReadonlyArray<Signal>,
  state: ShutdownSignalState,
  fiber: Fiber.RuntimeFiber<RuntimeFleet, RuntimeLaunchFailed>,
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

function observeFleetLaunchFiber(
  fiber: Fiber.RuntimeFiber<RuntimeFleet, RuntimeLaunchFailed>,
  state: ShutdownSignalState,
  cleanup: () => void,
  resume: (
    effect: Effect.Effect<
      RuntimeFleet,
      RuntimeLaunchFailed | RuntimeFleetStartupInterrupted
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
    new RuntimeFleetStartupInterrupted({
      signal,
      message: `Runtime fleet startup interrupted by ${signal}`,
    }),
  );
}

/**
 * Wraps {@link launchRuntimeFleet} with OS-signal handlers so user
 * Ctrl-C during startup interrupts cleanly instead of half-launching
 * a fleet.
 *
 * ```mermaid
 * flowchart TD
 *   LRFPS["launchRuntimeFleetWithProcessSignals(options)"]
 *   LRFPS --> FORK["Effect.runFork(launchRuntimeFleet) → fiber"]
 *   FORK --> SIGS["installProcessSignalHandlers<br>(SIGINT, SIGTERM by default)<br>first signal: shutdownSignal.value = signal<br>Fiber.interrupt(fiber)"]
 *   SIGS --> OBS["observeFleetLaunchFiber<br>routes by exit shape"]
 *   OBS -->|Success| OK["resume(Effect.succeed(fleet))"]
 *   OBS -->|Interrupted via signal| INT["resume(interruptedStartup(signal))<br>→ RuntimeFleetStartupInterrupted"]
 *   OBS -->|Other failure| ERR["resume(Effect.failCause(...))"]
 * ```
 *
 * @failure RuntimeFleetStartupInterrupted when a signal arrives during fleet startup
 */
export function launchRuntimeFleetWithProcessSignals(
  options: RuntimeFleetProcessSignalOptions,
): Effect.Effect<
  RuntimeFleet,
  RuntimeLaunchFailed | RuntimeFleetStartupInterrupted,
  never
> {
  const signals = options.signals ?? ["SIGINT", "SIGTERM"];
  return Effect.async<
    RuntimeFleet,
    RuntimeLaunchFailed | RuntimeFleetStartupInterrupted
  >((resume) => {
    const fiber = Effect.runFork(launchRuntimeFleet(options));
    const shutdownSignal: ShutdownSignalState = { value: null };
    const handlers = installProcessSignalHandlers(
      signals,
      shutdownSignal,
      fiber,
    );
    const cleanup = (): void => {
      cleanupProcessSignalHandlers(handlers);
    };

    observeFleetLaunchFiber(fiber, shutdownSignal, cleanup, resume);

    return Effect.sync(() => {
      cleanup();
      Effect.runFork(Fiber.interrupt(fiber));
    });
  });
}
