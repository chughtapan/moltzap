import { Effect, Exit, Fiber } from "effect";
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
  readonly signals?: ReadonlyArray<NodeJS.Signals>;
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

export class RuntimeFleetStartupInterrupted extends Error {
  readonly _tag = "RuntimeFleetStartupInterrupted" as const;

  constructor(readonly signal: NodeJS.Signals) {
    super(`Runtime fleet startup interrupted by ${signal}`);
  }
}

interface StartedRuntimeAgent {
  readonly spec: RuntimeAgentSpec;
  readonly runtime: Runtime;
}

interface PendingRuntimeAgent {
  readonly runtime: Runtime;
  readonly releaseStartupCleanup: Effect.Effect<void, never, never>;
}

class UnknownRuntimeAgent extends Error {
  readonly _tag = "UnknownRuntimeAgent" as const;

  constructor(
    readonly agentName: string,
    readonly knownAgents: ReadonlyArray<string>,
  ) {
    super(
      `Unknown runtime agent "${agentName}". Known agents: ${knownAgents.join(", ")}`,
    );
  }
}

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

function teardownStartedAgents(
  startedAgents: ReadonlyArray<StartedRuntimeAgent>,
): Effect.Effect<void, never, never> {
  return Effect.forEach(
    [...startedAgents].reverse(),
    (startedAgent) => startedAgent.runtime.teardown(),
    { discard: true },
  );
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
          new RuntimeReadyTimedOut(options.agent.agentName, ready.timeoutMs),
        );
      case "ProcessExited":
        return yield* Effect.fail(
          new RuntimeExitedBeforeReady(
            options.agent.agentName,
            ready.exitCode,
            ready.stderr,
          ),
        );
    }
  });
}

export function startRuntimeAgent(
  options: RuntimeStartOptions,
): Effect.Effect<Runtime, RuntimeLaunchFailed, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const pending = yield* startPendingRuntimeAgent(options);
      yield* pending.releaseStartupCleanup;
      return pending.runtime;
    }),
  );
}

export function launchRuntimeFleet(
  options: RuntimeFleetLaunchOptions,
): Effect.Effect<RuntimeFleet, RuntimeLaunchFailed, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const startedAgents: StartedRuntimeAgent[] = [];
      const launchOne = (agent: RuntimeAgentSpec) =>
        Effect.gen(function* () {
          const pending = yield* startPendingRuntimeAgent({
            kind: options.kind,
            server: options.server,
            agent,
            readyTimeoutMs: options.readyTimeoutMs,
            ...(options.openclaw !== undefined
              ? { openclaw: options.openclaw }
              : {}),
            ...(options.nanoclaw !== undefined
              ? { nanoclaw: options.nanoclaw }
              : {}),
            ...(options.claudeCode !== undefined
              ? { claudeCode: options.claudeCode }
              : {}),
          });
          const startedAgent = {
            spec: agent,
            runtime: pending.runtime,
          } satisfies StartedRuntimeAgent;
          startedAgents.push(startedAgent);
          yield* pending.releaseStartupCleanup;
          return startedAgent;
        });

      const started = yield* Effect.forEach(options.agents, launchOne, {
        concurrency: options.concurrency ?? 1,
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : teardownStartedAgents(startedAgents),
        ),
      );

      return {
        agents: started.map((startedAgent) => ({
          name: startedAgent.spec.agentName,
          agentId: startedAgent.spec.agentId,
        })),
        stopAll: () => teardownStartedAgents(started),
        getLogs(name: string): string {
          const startedAgent = started.find(
            (candidate) => candidate.spec.agentName === name,
          );
          if (startedAgent === undefined) {
            throw new UnknownRuntimeAgent(
              name,
              started.map((candidate) => candidate.spec.agentName),
            );
          }
          // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- log reads always start at offset 0 for fleet snapshots
          return startedAgent.runtime.getLogs(0).text;
        },
      } satisfies RuntimeFleet;
    }),
  );
}

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
    let shutdownSignal: NodeJS.Signals | null = null;

    const handlers = signals.map((signal) => {
      const handler = (): void => {
        if (shutdownSignal !== null) {
          return;
        }
        shutdownSignal = signal;
        Effect.runFork(Fiber.interrupt(fiber));
      };
      process.on(signal, handler);
      return { signal, handler };
    });

    const cleanup = (): void => {
      for (const { signal, handler } of handlers) {
        process.off(signal, handler);
      }
    };

    fiber.addObserver((exit) => {
      cleanup();
      if (Exit.isSuccess(exit)) {
        resume(Effect.succeed(exit.value));
        return;
      }
      if (shutdownSignal !== null && Exit.isInterrupted(exit)) {
        resume(Effect.fail(new RuntimeFleetStartupInterrupted(shutdownSignal)));
        return;
      }
      resume(Effect.failCause(exit.cause));
    });

    return Effect.sync(() => {
      cleanup();
      Effect.runFork(Fiber.interrupt(fiber));
    });
  });
}
