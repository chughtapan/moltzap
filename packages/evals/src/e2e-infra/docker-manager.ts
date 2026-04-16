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
  waitForChannel,
  getLogs,
  stopContainer as stopRawContainer,
  OPENCLAW_STATE_DIR,
  type ContainerModelConfig,
  type OpenClawContainer,
} from "@moltzap/openclaw-channel/test-utils";
import { DEFAULT_AGENT_MODEL_ID } from "./model-config.js";
import { logger } from "./logger.js";

const DEFAULT_EVAL_AGENT_IMAGE = "moltzap-eval-agent:local";

export interface AgentContainer {
  containerId: string;
  controlUiPort: number;
  name: string;
}

/** Find the monorepo root by walking up from this file looking for the build script. */
function findMonorepoRoot(): string | null {
  let dir = path.resolve(new URL(import.meta.url).pathname, "../../../..");
  for (let i = 0; i < 10; i++) {
    if (
      fs.existsSync(
        path.join(dir, "packages/evals/scripts/build-eval-agent.sh"),
      )
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export class DockerManager {
  private containers: Array<AgentContainer & { _raw: OpenClawContainer }> = [];
  private readonly imageName: string;

  constructor(opts?: { imageName?: string }) {
    this.imageName = opts?.imageName ?? DEFAULT_EVAL_AGENT_IMAGE;
  }

  /** Ensure the eval agent Docker image exists, auto-building if missing. */
  async ensureImage(): Promise<void> {
    try {
      execSync(`docker image inspect ${this.imageName}`, { stdio: "pipe" });
      logger.info(`Docker image "${this.imageName}" verified`);
      return;
    } catch {
      // Image missing, try to auto-build
    }

    logger.info(
      `Docker image "${this.imageName}" not found, attempting auto-build...`,
    );
    const root = findMonorepoRoot();
    if (!root) {
      throw new Error(
        `Docker image "${this.imageName}" not found and could not locate monorepo root to auto-build.\n` +
          `Build manually:\n` +
          `  cd <monorepo-root>\n` +
          `  bash packages/evals/scripts/build-eval-agent.sh`,
      );
    }

    try {
      execSync("bash packages/evals/scripts/build-eval-agent.sh", {
        cwd: root,
        stdio: "inherit",
      });
      logger.info(`Auto-built Docker image "${this.imageName}"`);
    } catch (err) {
      throw new Error(
        `Failed to auto-build Docker image "${this.imageName}".\n` +
          `Try building manually:\n` +
          `  cd ${root}\n` +
          `  bash packages/evals/scripts/build-eval-agent.sh\n` +
          `Error: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async startAgent(opts: {
    name: string;
    agentModelId?: string;
    moltzapServerUrl?: string;
    moltzapApiKey?: string;
    configOverride?: Record<string, unknown>;
    extraEnv?: Record<string, string>;
    workspaceFiles?: Array<{ relativePath: string; content: string }>;
  }): Promise<AgentContainer> {
    let openclawConfig: Record<string, unknown>;

    if (opts.configOverride) {
      openclawConfig = opts.configOverride;
    } else {
      const containerModel: ContainerModelConfig = {
        modelString: opts.agentModelId ?? DEFAULT_AGENT_MODEL_ID,
      };

      openclawConfig = buildOpenClawConfig({
        model: containerModel,
        serverUrl: opts.moltzapServerUrl!,
        agentApiKey: opts.moltzapApiKey!,
        agentName: opts.name,
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

    await waitForGateway(raw.containerId, 180_000);

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

  async startAgentAndWait(opts: {
    name: string;
    agentModelId?: string;
    moltzapServerUrl?: string;
    moltzapApiKey?: string;
    extraEnv?: Record<string, string>;
    workspaceFiles?: Array<{ relativePath: string; content: string }>;
    connectTimeoutMs?: number;
  }): Promise<AgentContainer> {
    const container = await this.startAgent(opts);
    await waitForChannel(
      container.containerId,
      opts.connectTimeoutMs ?? 180_000,
    );
    return container;
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

  /** Capture Docker stdout/stderr and internal pino logs to disk for all containers. */
  captureAllLogs(outputDir: string): void {
    fs.mkdirSync(outputDir, { recursive: true });
    for (const c of this.containers) {
      const agentDir = path.join(outputDir, c.name);
      fs.mkdirSync(agentDir, { recursive: true });

      // 1. Docker stdout/stderr
      const dockerLogs = getLogs(c.containerId);
      fs.writeFileSync(path.join(agentDir, "docker.log"), dockerLogs);

      // 2. Internal pino logs (bind-mounted tmpDir/logs/)
      const internalLogsDir = path.join(c._raw.tmpDir, "logs");
      if (fs.existsSync(internalLogsDir)) {
        const internalDest = path.join(agentDir, "internal");
        fs.mkdirSync(internalDest, { recursive: true });
        fs.cpSync(internalLogsDir, internalDest, { recursive: true });
      }
    }
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
  const dockerManager = new DockerManager();
  await dockerManager.ensureImage();

  let containers: AgentContainer[];
  try {
    containers = await Promise.all(
      opts.agentCredentials.map((cred) =>
        dockerManager.startAgent({
          name: cred.name,
          moltzapServerUrl: `ws://127.0.0.1:${opts.serverPort}`,
          moltzapApiKey: cred.apiKey,
          agentModelId: modelId,
          workspaceFiles: opts.workspaceFiles?.(cred.name),
        }),
      ),
    );
  } catch (err) {
    await dockerManager.stopAll();
    throw err;
  }

  return { dockerManager, containers };
}
