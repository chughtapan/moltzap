/**
 * Manages nanoclaw processes for E2E evals.
 *
 * Each agent runs as a separate subprocess with an isolated working
 * directory (store, groups, data). The shared nanoclaw binary and
 * node_modules are symlinked to avoid copying ~200MB per agent.
 */

import {
  ensureNanoclawInstalled,
  startNanoclawSmoke,
  stopNanoclawSmoke,
  getNanoclawLogs,
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

    const handle = await startNanoclawSmoke({
      apiKey: opts.apiKey,
      serverUrl: opts.serverUrl,
      workspaceFiles: opts.workspaceFiles,
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
