/**
 * Unified agent fleet launcher for E2E evals.
 *
 * Dispatches to DockerManager (openclaw) or NanoclawManager (nanoclaw),
 * blocking until all agents are connected. Returns a single AgentFleet
 * handle for cleanup and log access.
 */

import { Duration, Effect } from "effect";
import { DockerManager, type AgentContainer } from "./docker-manager.js";
import { NanoclawManager, type NanoclawAgent } from "./nanoclaw-manager.js";
import { logger } from "./logger.js";
import { ContainerError } from "./types.js";
import {
  createFleetStartedTelemetryEvent,
  createFleetStoppedTelemetryEvent,
  telemetry,
} from "./telemetry.js";

export type AgentRuntime = "openclaw" | "nanoclaw";

export interface FleetAgent {
  name: string;
}

export interface AgentFleet {
  agents: FleetAgent[];
  stopAll(): Promise<void>; // #ignore-sloppy-code[promise-type]: fleet public API — caller `runE2EEvalsImpl` still awaits at the process edge
  getLogs(name: string): string;
}

export interface LaunchFleetOpts {
  runtime: AgentRuntime;
  agents: Array<{ name: string; apiKey: string }>;
  serverUrl: string;
  modelId?: string;
  /** Only applies to openclaw runtime. Nanoclaw uses cached workspace from ensureNanoclawInstalled. */
  workspaceFiles?: (
    name: string,
  ) => Array<{ relativePath: string; content: string }>;
  /** Timeout for each agent to connect. Defaults to 180_000 (180s). */
  connectTimeoutMs?: number;
}

const POST_CONNECT_SETTLE = Duration.seconds(2);

/** Effect-native fleet launcher. Caller at the process edge (`runE2EEvals`) bridges via `runPromise`. */
export const launchFleetEffect = (
  opts: LaunchFleetOpts,
): Effect.Effect<AgentFleet, Error> =>
  opts.runtime === "openclaw"
    ? launchOpenClawFleet(opts)
    : launchNanoclawFleet(opts);

// #ignore-sloppy-code-next-line[promise-type]: process-edge bridge for `runE2EEvalsImpl`
export function launchFleet(opts: LaunchFleetOpts): Promise<AgentFleet> {
  return Effect.runPromise(launchFleetEffect(opts));
}

const launchOpenClawFleet = (
  opts: LaunchFleetOpts,
): Effect.Effect<AgentFleet, Error> =>
  Effect.gen(function* () {
    const dockerManager = new DockerManager();
    yield* dockerManager
      .ensureImage()
      .pipe(Effect.mapError((err) => new Error(err.message)));

    // Parallel startup: each agent runs its own Effect. On partial failure,
    // tapError stops any already-started containers before the typed
    // DockerError surfaces.
    const startAll = Effect.forEach(
      opts.agents,
      (agent) =>
        dockerManager.startAgentAndWait({
          name: agent.name,
          moltzapServerUrl: opts.serverUrl,
          moltzapApiKey: agent.apiKey,
          agentModelId: opts.modelId,
          workspaceFiles: opts.workspaceFiles?.(agent.name),
          connectTimeoutMs: opts.connectTimeoutMs ?? 180_000,
        }),
      { concurrency: "unbounded" },
    ).pipe(Effect.tapError(() => dockerManager.stopAll()));

    const containers: AgentContainer[] = yield* startAll.pipe(
      Effect.tap(() => Effect.sleep(POST_CONNECT_SETTLE)),
      Effect.mapError((err) => new Error(err.message)),
    );

    yield* Effect.sync(() =>
      logger.info(`Fleet started: ${containers.length} openclaw agent(s)`),
    );
    telemetry.emit(
      createFleetStartedTelemetryEvent({
        ts: new Date().toISOString(),
        runtime: "openclaw",
        agentNames: containers.map((c) => c.name),
        serverUrl: opts.serverUrl,
      }),
    );

    const agentMap = new Map(containers.map((c) => [c.name, c]));

    return {
      agents: containers.map((c) => ({ name: c.name })),
      stopAll: () =>
        Effect.runPromise(
          Effect.gen(function* () {
            // Capture logs before stopping for post-mortem access.
            for (const c of containers) {
              const logs = dockerManager.getContainerLogs(c);
              if (logs && logs !== "(no logs available)") {
                const last20 = logs.split("\n").slice(-20).join("\n");
                yield* Effect.sync(() =>
                  logger.info(
                    `Fleet agent "${c.name}" logs (last 20):\n${last20}`,
                  ),
                );
              }
            }
            yield* dockerManager.stopAll();
            telemetry.emit(
              createFleetStoppedTelemetryEvent({
                ts: new Date().toISOString(),
                runtime: "openclaw",
                agentNames: containers.map((c) => c.name),
              }),
            );
          }),
        ),
      getLogs(name: string): string {
        const container = agentMap.get(name);
        if (!container) {
          throw new Error(
            `Unknown fleet agent "${name}". Known agents: ${[...agentMap.keys()].join(", ")}`,
          );
        }
        return dockerManager.getContainerLogs(container);
      },
    } satisfies AgentFleet;
  });

const launchNanoclawFleet = (
  opts: LaunchFleetOpts,
): Effect.Effect<AgentFleet, Error> =>
  Effect.gen(function* () {
    const nanoclawManager = new NanoclawManager();
    yield* Effect.tryPromise({
      try: () => nanoclawManager.ensureInstalled(),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

    // Sequential — nanoclaw spawns subcontainers via OneCLI and parallel starts
    // overwhelm the gateway. Effect.forEach without `concurrency` is sequential.
    const startAll = Effect.forEach(opts.agents, (agentOpts) =>
      Effect.tryPromise({
        try: () =>
          nanoclawManager.startAgent({
            name: agentOpts.name,
            apiKey: agentOpts.apiKey,
            serverUrl: opts.serverUrl,
            workspaceFiles: opts.workspaceFiles?.(agentOpts.name),
          }),
        catch: (e) =>
          new ContainerError({
            containerName: agentOpts.name,
            phase: "start",
            message: e instanceof Error ? e.message : String(e),
          }),
      }),
    ).pipe(
      Effect.tapError(() =>
        Effect.tryPromise({
          try: () => nanoclawManager.stopAll(),
          catch: () => undefined,
        }).pipe(Effect.ignore),
      ),
      // Grace delay: let the server register all connections before callers proceed.
      Effect.tap(() => Effect.sleep(POST_CONNECT_SETTLE)),
      Effect.mapError((err) => new Error(err.message)),
    );

    const agents: NanoclawAgent[] = yield* startAll;

    yield* Effect.sync(() =>
      logger.info(`Fleet started: ${agents.length} nanoclaw agent(s)`),
    );
    telemetry.emit(
      createFleetStartedTelemetryEvent({
        ts: new Date().toISOString(),
        runtime: "nanoclaw",
        agentNames: agents.map((a) => a.name),
        serverUrl: opts.serverUrl,
      }),
    );

    const agentMap = new Map(agents.map((a) => [a.name, a]));

    return {
      agents: agents.map((a) => ({ name: a.name })),
      stopAll: () =>
        Effect.runPromise(
          Effect.gen(function* () {
            // Capture logs before stopping for post-mortem access.
            for (const a of agents) {
              const logs = nanoclawManager.getAgentLogs(a);
              if (logs) {
                const last20 = logs.split("\n").slice(-20).join("\n");
                yield* Effect.sync(() =>
                  logger.info(
                    `Fleet agent "${a.name}" logs (last 20):\n${last20}`,
                  ),
                );
              }
            }
            yield* Effect.tryPromise({
              try: () => nanoclawManager.stopAll(),
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            });
            telemetry.emit(
              createFleetStoppedTelemetryEvent({
                ts: new Date().toISOString(),
                runtime: "nanoclaw",
                agentNames: agents.map((a) => a.name),
              }),
            );
          }),
        ),
      getLogs(name: string): string {
        const agent = agentMap.get(name);
        if (!agent) {
          throw new Error(
            `Unknown fleet agent "${name}". Known agents: ${[...agentMap.keys()].join(", ")}`,
          );
        }
        return nanoclawManager.getAgentLogs(agent);
      },
    } satisfies AgentFleet;
  });
