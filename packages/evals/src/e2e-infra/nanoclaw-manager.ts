/**
 * Manages nanoclaw processes for E2E evals.
 *
 * Each agent is a separate nanoclaw subprocess sharing a cached binary
 * and OneCLI gateway. Mirrors DockerManager's API surface.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ensureNanoclawInstalled,
  startNanoclawSmoke,
  stopNanoclawSmoke,
  getNanoclawLogs,
  NANOCLAW_CACHE,
  type NanoclawSmokeHandle,
} from "./nanoclaw-smoke.js";
import { logger } from "./logger.js";

export interface NanoclawAgent {
  name: string;
  handle: NanoclawSmokeHandle;
}

export class NanoclawManager {
  private agents: NanoclawAgent[] = [];

  async ensureInstalled(): Promise<void> {
    await ensureNanoclawInstalled();
  }

  async startAgent(opts: {
    name: string;
    apiKey: string;
    serverUrl: string;
    workspaceFiles?: Array<{ relativePath: string; content: string }>;
  }): Promise<NanoclawAgent> {
    logger.info(`Starting nanoclaw agent "${opts.name}"`);

    // Write workspace files into the nanoclaw cache's container tree.
    // Skills are volume-mounted at runtime (not baked into the image),
    // so changes here are visible to the next subcontainer launch.
    if (opts.workspaceFiles) {
      for (const file of opts.workspaceFiles) {
        const destPath = path.join(
          NANOCLAW_CACHE,
          "container/skills",
          file.relativePath,
        );
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, file.content);
      }
    }

    const handle = await startNanoclawSmoke({
      apiKey: opts.apiKey,
      serverUrl: opts.serverUrl,
    });
    const agent: NanoclawAgent = { name: opts.name, handle };
    this.agents.push(agent);
    logger.info(`Nanoclaw agent "${opts.name}" connected`);
    return agent;
  }

  async stopAgent(agent: NanoclawAgent): Promise<void> {
    try {
      await stopNanoclawSmoke(agent.handle);
    } catch (err) {
      logger.warn(
        `Failed to stop nanoclaw agent "${agent.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.agents = this.agents.filter((a) => a !== agent);
  }

  async stopAll(): Promise<void> {
    logger.info(`Stopping ${this.agents.length} nanoclaw agent(s)`);
    const agents = [...this.agents];
    this.agents = [];
    await Promise.allSettled(
      agents.map(async (agent) => {
        try {
          await stopNanoclawSmoke(agent.handle);
        } catch (err) {
          logger.warn(
            `Failed to stop nanoclaw agent "${agent.name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }

  getAgentLogs(agent: NanoclawAgent): string {
    return getNanoclawLogs(agent.handle);
  }
}
