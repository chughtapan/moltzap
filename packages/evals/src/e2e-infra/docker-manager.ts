/**
 * Manages OpenClaw Docker containers for E2E evals.
 *
 * Supports two modes:
 *   - Tier 5 evals: `moltzap-eval-agent:local` image with MoltZap channel pre-installed.
 *     Pass `moltzapServerUrl` + `moltzapApiKey` to `startAgent`.
 *   - Management evals: stock `openclaw:local` image. Pass `configOverride` to `startAgent`.
 */

import { execSync } from "node:child_process";
import {
  buildOpenClawConfig,
  startRawContainer,
  waitForGateway,
  getLogs,
  stopContainer as stopRawContainer,
  type ContainerModelConfig,
  type OpenClawContainer,
} from "@moltzap/openclaw-channel/test-utils";
import type { AgentModelConfig } from "./model-config.js";
import { logger } from "./logger.js";

const DEFAULT_EVAL_AGENT_IMAGE = "moltzap-eval-agent:local";

export interface AgentContainer {
  containerId: string;
  controlUiPort: number;
  name: string;
}

export class DockerManager {
  private containers: Array<AgentContainer & { _raw: OpenClawContainer }> = [];
  private readonly imageName: string;

  constructor(opts?: { imageName?: string }) {
    this.imageName = opts?.imageName ?? DEFAULT_EVAL_AGENT_IMAGE;
  }

  async verifyImage(): Promise<void> {
    try {
      execSync(`docker image inspect ${this.imageName}`, { stdio: "pipe" });
    } catch {
      throw new Error(
        `Docker image "${this.imageName}" not found.\n` +
          `Build it:\n` +
          `  cd <monorepo-root>\n` +
          `  bash packages/evals/scripts/build-eval-agent.sh`,
      );
    }
    logger.info(`Docker image "${this.imageName}" verified`);
  }

  async startAgent(opts: {
    name: string;
    zaiApiKey: string;
    agentModel?: AgentModelConfig;
    moltzapServerUrl?: string;
    moltzapApiKey?: string;
    configOverride?: Record<string, unknown>;
    extraEnv?: Record<string, string>;
  }): Promise<AgentContainer> {
    let openclawConfig: Record<string, unknown>;

    if (opts.configOverride) {
      openclawConfig = opts.configOverride;
    } else {
      const containerModel: ContainerModelConfig = opts.agentModel
        ? {
            provider: opts.agentModel.provider,
            modelId: opts.agentModel.modelId,
            modelString: opts.agentModel.id,
            envVar: opts.agentModel.envVar,
          }
        : { provider: "zai", modelId: "glm-4.7", modelString: "zai/glm-4.7" };

      openclawConfig = buildOpenClawConfig({
        model: containerModel,
        serverUrl: opts.moltzapServerUrl!,
        agentApiKey: opts.moltzapApiKey!,
        agentName: opts.name,
      });
    }

    const envVars: Record<string, string> = {
      ZAI_API_KEY: opts.zaiApiKey,
      ...opts.extraEnv,
    };
    if (opts.agentModel && opts.agentModel.envVar !== "ZAI_API_KEY") {
      const apiKey = process.env[opts.agentModel.envVar];
      if (apiKey) envVars[opts.agentModel.envVar] = apiKey;
    }

    logger.info(`Starting agent container "${opts.name}"`);

    const raw = startRawContainer(openclawConfig, {
      name: opts.name,
      agentName: opts.name,
      envVars,
    });

    await waitForGateway(raw.containerId, 60_000);

    const agent: AgentContainer & { _raw: OpenClawContainer } = {
      containerId: raw.containerId,
      controlUiPort: raw.controlPort,
      name: opts.name,
      _raw: raw,
    };
    this.containers.push(agent);
    logger.info(
      `Agent "${opts.name}" started (container: ${raw.containerId.slice(0, 12)}, port: ${raw.controlPort})`,
    );
    return agent;
  }

  async stopAgent(agent: AgentContainer): Promise<void> {
    const entry = this.containers.find((c) => c === agent);
    if (entry) stopRawContainer(entry._raw);
    this.containers = this.containers.filter((c) => c !== agent);
  }

  async stopAll(): Promise<void> {
    logger.info(`Stopping ${this.containers.length} agent container(s)`);
    for (const c of this.containers) {
      stopRawContainer(c._raw);
    }
    this.containers = [];
  }

  getContainerLogs(agent: AgentContainer): string {
    return getLogs(agent.containerId);
  }
}
