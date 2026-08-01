import { Data, Effect, Exit, Fiber, Schema } from "effect";
import type { Signal } from "@effect/platform/CommandExecutor";
import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import { ServerBaseUrl } from "@moltzap/protocol/network";
import {
  RuntimeExitedBeforeReady,
  type RuntimeLaunchFailed,
  RuntimeReadyTimedOut,
  spawnFailed,
  type SpawnFailed,
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
  type Runtime,
  type RuntimeServerHandle,
  type SpawnInput,
  type WorkspaceFile,
} from "./runtime.js";
import { type InstallMode, resolveInstallMode } from "./install-mode.js";

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

// Adapters take a decided install mode; a launch may override the one this
// module resolves, so the mode is optional on the caller-facing overrides.
type RuntimeOverrides<Options> = Omit<Options, "server" | "installMode"> & {
  readonly installMode?: InstallMode;
};

type RuntimeSelection =
  | {
      readonly kind: "openclaw";
      readonly openclaw?: RuntimeOverrides<OpenClawAdapterOptions>;
      readonly nanoclaw?: never;
    }
  | {
      readonly kind: "nanoclaw";
      readonly nanoclaw?: RuntimeOverrides<NanoclawAdapterOptions>;
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

/** One agent's spec paired with the `SpawnInput` decoded from it. */
interface DecodedAgent {
  readonly agent: TestbedAgentSpec;
  readonly spawnInput: SpawnInput;
}
/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
export type { InstallMode } from "./install-mode.js";

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
      const spawnInput = yield* toSpawnInput(options.agent);
      const installMode = yield* resolveInstallMode(
        installModeOverride(options),
      );
      const pending = yield* startPendingRuntimeAgent(
        options,
        installMode,
        spawnInput,
      );
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
      // Every address is decoded before the first process starts: a bad one
      // discovered mid-launch would cost the spawn and teardown of every
      // agent ahead of it.
      const decoded = yield* Effect.forEach(
        options.agents,
        (agent) =>
          Effect.map(
            toSpawnInput(agent),
            (spawnInput): DecodedAgent => ({ agent, spawnInput }),
          ),
        { concurrency: 1 },
      );
      const installMode = yield* resolveInstallMode(
        installModeOverride(options),
      );
      const started = yield* Effect.forEach(
        decoded,
        (entry) =>
          startTestbedAgent(options, startedAgents, entry, installMode),
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

function installModeOverride(
  options: RuntimeStartOptions | TestbedLaunchOptions,
): InstallMode | undefined {
  switch (options.kind) {
    case "openclaw":
      return options.openclaw?.installMode;
    case "nanoclaw":
      return options.nanoclaw?.installMode;
  }
}

// `TestbedAgentSpec` is the package boundary, so the address is decoded here
// rather than trusted; downstream every adapter holds a path-free `ServerUrl`.
function toSpawnInput(
  agent: TestbedAgentSpec,
): Effect.Effect<SpawnInput, SpawnFailed> {
  return decodeServerUrl(agent.serverUrl).pipe(
    Effect.mapError((cause) => spawnFailed(agent.agentName, cause)),
    Effect.map((serverUrl) => ({
      agentName: AgentName(agent.agentName),
      apiKey: agent.apiKey,
      agentId: agent.agentId,
      serverUrl,
      ...(agent.workspaceFiles !== undefined
        ? { workspaceFiles: agent.workspaceFiles }
        : {}),
      ...(agent.modelId !== undefined ? { modelId: agent.modelId } : {}),
    })),
  );
}

function startPendingRuntimeAgent(
  options: RuntimeStartOptions,
  installMode: InstallMode,
  spawnInput: SpawnInput,
) {
  const runtime = createRuntime(options, installMode);
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

function startTestbedAgent(
  options: TestbedLaunchOptions,
  startedAgents: StartedRuntimeAgent[],
  decoded: DecodedAgent,
  installMode: InstallMode,
) {
  return Effect.gen(function* () {
    const pending = yield* startPendingRuntimeAgent(
      runtimeStartOptionsForAgent(options, decoded.agent),
      installMode,
      decoded.spawnInput,
    );
    const startedAgent = {
      spec: decoded.agent,
      runtime: pending.runtime,
    } satisfies StartedRuntimeAgent;
    startedAgents.push(startedAgent);
    yield* pending.releaseStartupCleanup;
    return startedAgent;
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

const decodeServerUrl = Schema.decodeEither(ServerBaseUrl);

function createRuntime(
  options: RuntimeStartOptions,
  installMode: InstallMode,
): Runtime {
  switch (options.kind) {
    case "openclaw":
      return createOpenClawAdapter({
        server: options.server,
        ...options.openclaw,
        installMode,
      });
    case "nanoclaw":
      return new NanoclawAdapter({
        server: options.server,
        ...options.nanoclaw,
        installMode,
      });
  }
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

function interruptedStartup(signal: Signal) {
  return Effect.fail(
    new TestbedStartupInterrupted({
      signal,
      message: `Testbed startup interrupted by ${signal}`,
    }),
  );
}
