import { Effect } from "effect";
import {
  RuntimeExitedBeforeReady,
  RuntimeReadyTimedOut,
  type RuntimeLaunchFailed,
} from "./errors.js";
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

export type RuntimeKind = "openclaw" | "nanoclaw";

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
}

export interface RuntimeFleetLaunchOptions {
  readonly kind: RuntimeKind;
  readonly server: RuntimeServerHandle;
  readonly agents: ReadonlyArray<RuntimeAgentSpec>;
  readonly readyTimeoutMs: number;
  readonly openclaw?: Omit<WorkspaceOpenClawAdapterInput, "server">;
  readonly nanoclaw?: Omit<NanoclawAdapterDeps, "server">;
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

interface StartedRuntimeAgent {
  readonly spec: RuntimeAgentSpec;
  readonly runtime: Runtime;
}

function createRuntime(options: RuntimeStartOptions): Runtime {
  if (options.kind === "openclaw") {
    return createWorkspaceOpenClawAdapter({
      server: options.server,
      ...options.openclaw,
    });
  }
  return new NanoclawAdapter({
    server: options.server,
    ...options.nanoclaw,
  });
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

export function startRuntimeAgent(
  options: RuntimeStartOptions,
): Effect.Effect<Runtime, RuntimeLaunchFailed, never> {
  const runtime = createRuntime(options);
  return Effect.gen(function* () {
    yield* runtime.spawn(toSpawnInput(options.agent));
    const ready = yield* runtime.waitUntilReady(options.readyTimeoutMs);
    switch (ready._tag) {
      case "Ready":
        return runtime;
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

export function launchRuntimeFleet(
  options: RuntimeFleetLaunchOptions,
): Effect.Effect<RuntimeFleet, RuntimeLaunchFailed, never> {
  return Effect.gen(function* () {
    const startedAgents: StartedRuntimeAgent[] = [];
    const launchOne = (agent: RuntimeAgentSpec) =>
      startRuntimeAgent({
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
      }).pipe(
        Effect.map((runtime) => {
          const startedAgent = {
            spec: agent,
            runtime,
          } satisfies StartedRuntimeAgent;
          startedAgents.push(startedAgent);
          return startedAgent;
        }),
      );

    const started = yield* Effect.catchAll(
      Effect.forEach(options.agents, launchOne, { concurrency: 1 }),
      (error) =>
        teardownStartedAgents(startedAgents).pipe(
          Effect.zipRight(Effect.fail(error)),
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
          throw new Error(
            `Unknown runtime agent "${name}". Known agents: ${started
              .map((candidate) => candidate.spec.agentName)
              .join(", ")}`,
          );
        }
        return startedAgent.runtime.getLogs(0).text;
      },
    } satisfies RuntimeFleet;
  });
}
