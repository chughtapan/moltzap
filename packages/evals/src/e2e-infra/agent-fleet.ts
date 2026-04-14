/**
 * Unified agent fleet launcher for E2E evals.
 *
 * Dispatches to DockerManager (openclaw) or NanoclawManager (nanoclaw),
 * blocking until all agents are connected. Returns a single AgentFleet
 * handle for cleanup and log access.
 */

import { DockerManager, type AgentContainer } from "./docker-manager.js";
import { NanoclawManager, type NanoclawAgent } from "./nanoclaw-manager.js";
import { logger } from "./logger.js";

export type AgentRuntime = "openclaw" | "nanoclaw";

export interface FleetAgent {
  name: string;
}

export interface AgentFleet {
  agents: FleetAgent[];
  stopAll(): Promise<void>;
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

const POST_CONNECT_SETTLE_MS = 2_000;

export async function launchFleet(opts: LaunchFleetOpts): Promise<AgentFleet> {
  if (opts.runtime === "openclaw") {
    return launchOpenClawFleet(opts);
  }
  return launchNanoclawFleet(opts);
}

async function launchOpenClawFleet(opts: LaunchFleetOpts): Promise<AgentFleet> {
  const dockerManager = new DockerManager();
  await dockerManager.ensureImage();

  let containers: AgentContainer[];
  try {
    containers = await Promise.all(
      opts.agents.map((agent) =>
        dockerManager.startAgentAndWait({
          name: agent.name,
          moltzapServerUrl: opts.serverUrl,
          moltzapApiKey: agent.apiKey,
          agentModelId: opts.modelId,
          workspaceFiles: opts.workspaceFiles?.(agent.name),
          connectTimeoutMs: opts.connectTimeoutMs ?? 180_000,
        }),
      ),
    );
  } catch (err) {
    // Partial failure: stop already-started containers before rethrowing.
    await dockerManager.stopAll();
    throw err;
  }

  // Grace delay: let the server register all connections before callers proceed.
  await new Promise((r) => setTimeout(r, POST_CONNECT_SETTLE_MS));

  logger.info(`Fleet started: ${containers.length} openclaw agent(s)`);

  const agentMap = new Map(containers.map((c) => [c.name, c]));

  return {
    agents: containers.map((c) => ({ name: c.name })),
    async stopAll() {
      // Capture logs before stopping for post-mortem access.
      for (const c of containers) {
        const logs = dockerManager.getContainerLogs(c);
        if (logs && logs !== "(no logs available)") {
          const last20 = logs.split("\n").slice(-20).join("\n");
          logger.info(`Fleet agent "${c.name}" logs (last 20):\n${last20}`);
        }
      }
      await dockerManager.stopAll();
    },
    getLogs(name: string): string {
      const container = agentMap.get(name);
      if (!container) {
        throw new Error(
          `Unknown fleet agent "${name}". Known agents: ${[...agentMap.keys()].join(", ")}`,
        );
      }
      return dockerManager.getContainerLogs(container);
    },
  };
}

async function launchNanoclawFleet(opts: LaunchFleetOpts): Promise<AgentFleet> {
  const nanoclawManager = new NanoclawManager();
  await nanoclawManager.ensureInstalled();

  const agents: NanoclawAgent[] = [];
  try {
    // Sequential to avoid overwhelming OneCLI/Docker.
    for (const agentOpts of opts.agents) {
      const agent = await nanoclawManager.startAgent({
        name: agentOpts.name,
        apiKey: agentOpts.apiKey,
        serverUrl: opts.serverUrl,
        workspaceFiles: opts.workspaceFiles?.(agentOpts.name),
      });
      agents.push(agent);
    }
  } catch (err) {
    // Partial failure: stop already-started agents before rethrowing.
    await nanoclawManager.stopAll();
    throw err;
  }

  // Grace delay: let the server register all connections before callers proceed.
  await new Promise((r) => setTimeout(r, POST_CONNECT_SETTLE_MS));

  logger.info(`Fleet started: ${agents.length} nanoclaw agent(s)`);

  const agentMap = new Map(agents.map((a) => [a.name, a]));

  return {
    agents: agents.map((a) => ({ name: a.name })),
    async stopAll() {
      // Capture logs before stopping for post-mortem access.
      for (const a of agents) {
        const logs = nanoclawManager.getAgentLogs(a);
        if (logs) {
          const last20 = logs.split("\n").slice(-20).join("\n");
          logger.info(`Fleet agent "${a.name}" logs (last 20):\n${last20}`);
        }
      }
      await nanoclawManager.stopAll();
    },
    getLogs(name: string): string {
      const agent = agentMap.get(name);
      if (!agent) {
        throw new Error(
          `Unknown fleet agent "${name}". Known agents: ${[...agentMap.keys()].join(", ")}`,
        );
      }
      return nanoclawManager.getAgentLogs(agent);
    },
  };
}
