/**
 * Manages OpenClaw Docker containers for E2E evals.
 *
 * Supports two modes:
 *   - Tier 5 evals: `moltzap-eval-agent:local` image with MoltZap channel pre-installed.
 *     Pass `moltzapServerUrl` + `moltzapApiKey` to `startAgent`.
 *   - Management evals: stock `openclaw:local` image. Pass `configOverride` to `startAgent`.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  buildOpenClawConfig,
  startRawContainer,
  waitForGateway,
  getLogs,
  stopContainer as stopRawContainer,
  OPENCLAW_STATE_DIR,
  type ContainerModelConfig,
  type OpenClawContainer,
} from "@moltzap/openclaw-channel/test-utils";
import {
  type AgentModelConfig,
  resolveAgentModel,
  DEFAULT_AGENT_MODEL_ID,
} from "./model-config.js";
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
    agentModel?: AgentModelConfig;
    moltzapServerUrl?: string;
    moltzapApiKey?: string;
    configOverride?: Record<string, unknown>;
    extraEnv?: Record<string, string>;
    workspaceFiles?: Array<{ relativePath: string; content: string }>;
    contextAdapter?: {
      type: string;
      maxConversations?: number;
      maxMessagesPerConv?: number;
    };
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
        contextAdapter: opts.contextAdapter,
      });
    }

    const envVars: Record<string, string> = { ...opts.extraEnv };
    for (const [key, value] of Object.entries(process.env)) {
      if (key.endsWith("_API_KEY") && value) {
        envVars[key] = value;
      }
    }

    logger.info(`Starting agent container "${opts.name}"`);

    const raw = startRawContainer(openclawConfig, {
      name: opts.name,
      agentName: opts.name,
      envVars,
    });

    // Write custom workspace files into the container after creation.
    if (opts.workspaceFiles) {
      for (const file of opts.workspaceFiles) {
        const filePath = path.join(raw.tmpDir, "workspace", file.relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, file.content);
      }
      // Copy updated workspace into the running container and fix ownership.
      execSync(
        `docker cp ${raw.tmpDir}/workspace/. ${raw.containerId}:${OPENCLAW_STATE_DIR}/workspace/`,
      );
      execSync(
        `docker exec -u root ${raw.containerId} sh -lc "chown -R node:node ${OPENCLAW_STATE_DIR}/workspace"`,
      );
    }

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

/** Start N agent containers with model resolution and API key forwarding. */
export async function setupAgentContainers(opts: {
  agentCredentials: Array<{ name: string; apiKey: string }>;
  serverPort: number;
  modelId?: string;
  workspaceFiles?: (
    name: string,
  ) => Array<{ relativePath: string; content: string }>;
}): Promise<{
  dockerManager: DockerManager;
  containers: AgentContainer[];
}> {
  const modelId = opts.modelId ?? DEFAULT_AGENT_MODEL_ID;
  const agentModel = resolveAgentModel(modelId);
  const dockerManager = new DockerManager();
  await dockerManager.verifyImage();

  const containers: AgentContainer[] = [];
  for (const cred of opts.agentCredentials) {
    const container = await dockerManager.startAgent({
      name: cred.name,
      moltzapServerUrl: `ws://127.0.0.1:${opts.serverPort}`,
      moltzapApiKey: cred.apiKey,
      agentModel,
      workspaceFiles: opts.workspaceFiles?.(cred.name),
    });
    containers.push(container);
  }

  return { dockerManager, containers };
}
