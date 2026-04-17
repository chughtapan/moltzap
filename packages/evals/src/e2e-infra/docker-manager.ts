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
import { Effect, type Scope } from "effect";
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
import { ContainerError } from "./types.js";

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

  /**
   * Ensure the eval agent Docker image exists, auto-building if missing.
   * Entirely synchronous (`execSync`) — no Promise boundary needed.
   */
  ensureImage(): void {
    try {
      execSync(`docker image inspect ${this.imageName}`, { stdio: "pipe" });
      logger.info(`Docker image "${this.imageName}" verified`);
      return;
    } catch (err) {
      logger.debug(
        `Docker image "${this.imageName}" inspect failed (${
          err instanceof Error ? err.message : String(err)
        }); will attempt auto-build`,
      );
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

  startAgent(opts: {
    name: string;
    agentModelId?: string;
    moltzapServerUrl?: string;
    moltzapApiKey?: string;
    configOverride?: Record<string, unknown>;
    extraEnv?: Record<string, string>;
    workspaceFiles?: Array<{ relativePath: string; content: string }>;
  }): Effect.Effect<AgentContainer, ContainerError> {
    return Effect.tryPromise({
      try: () => this.startAgentImpl(opts),
      catch: (e) =>
        new ContainerError({
          containerName: opts.name,
          phase: "start",
          message: e instanceof Error ? e.message : String(e),
        }),
    });
  }

  // #ignore-sloppy-code-next-line[async-keyword]: Docker exec boundary
  private async startAgentImpl(opts: {
    name: string;
    agentModelId?: string;
    moltzapServerUrl?: string;
    moltzapApiKey?: string;
    configOverride?: Record<string, unknown>;
    extraEnv?: Record<string, string>;
    workspaceFiles?: Array<{ relativePath: string; content: string }>;
    // #ignore-sloppy-code-next-line[promise-type]: Docker exec boundary
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

  startAgentAndWait(opts: {
    name: string;
    agentModelId?: string;
    moltzapServerUrl?: string;
    moltzapApiKey?: string;
    extraEnv?: Record<string, string>;
    workspaceFiles?: Array<{ relativePath: string; content: string }>;
    connectTimeoutMs?: number;
  }): Effect.Effect<AgentContainer, ContainerError> {
    return Effect.gen(this, function* () {
      const container = yield* this.startAgent(opts);
      yield* Effect.tryPromise({
        try: () =>
          waitForChannel(
            container.containerId,
            opts.connectTimeoutMs ?? 180_000,
          ),
        catch: (e) =>
          new ContainerError({
            containerName: opts.name,
            phase: "wait",
            message: e instanceof Error ? e.message : String(e),
          }),
      });
      return container;
    });
  }

  stopAgent(agent: AgentContainer): Effect.Effect<void, ContainerError> {
    return Effect.sync(() => {
      const entry = this.containers.find((c) => c === agent);
      if (entry) stopRawContainer(entry._raw);
      this.containers = this.containers.filter((c) => c !== agent);
    });
  }

  stopAll(): Effect.Effect<void, ContainerError> {
    return Effect.sync(() => {
      logger.info(`Stopping ${this.containers.length} agent container(s)`);
      for (const c of this.containers) {
        stopRawContainer(c._raw);
      }
      this.containers = [];
    });
  }

  getContainerLogs(agent: AgentContainer): string {
    return getLogs(agent.containerId);
  }
}

/**
 * Start N agent containers with model resolution and API key forwarding.
 * Returns an Effect; callers at the process edge can bridge via
 * `Effect.runPromise`.
 */
export const setupAgentContainers = (opts: {
  agentCredentials: Array<{ name: string; apiKey: string }>;
  serverPort: number;
  modelId?: string;
  workspaceFiles?: (
    name: string,
  ) => Array<{ relativePath: string; content: string }>;
}): Effect.Effect<
  {
    dockerManager: DockerManager;
    containers: AgentContainer[];
  },
  Error
> =>
  Effect.gen(function* () {
    const modelId = opts.modelId ?? DEFAULT_AGENT_MODEL_ID;
    const dockerManager = new DockerManager();
    yield* Effect.try({
      try: () => dockerManager.ensureImage(),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    });

    // Concurrent startup. On partial failure, already-started containers are
    // stopped before the error is rethrown. `startAgent` is Effect-native now,
    // so `Effect.forEach` yields each child directly.
    const containers = yield* Effect.forEach(
      opts.agentCredentials,
      (cred) =>
        dockerManager.startAgent({
          name: cred.name,
          moltzapServerUrl: `ws://127.0.0.1:${opts.serverPort}`,
          moltzapApiKey: cred.apiKey,
          agentModelId: modelId,
          workspaceFiles: opts.workspaceFiles?.(cred.name),
        }),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.tapError(() => dockerManager.stopAll().pipe(Effect.ignore)),
      Effect.mapError((err) => new Error(err.message)),
    );

    return { dockerManager, containers };
  });

/**
 * Effect-native scoped agent container. Use with `Effect.scoped` so the
 * container is guaranteed to stop even if the wrapped work fails or is
 * interrupted. Now that `DockerManager.startAgent` itself returns an Effect,
 * this is a thin `Effect.acquireRelease` wrapper.
 */
export const scopedAgent = (
  dockerManager: DockerManager,
  opts: Parameters<DockerManager["startAgent"]>[0],
): Effect.Effect<AgentContainer, ContainerError, Scope.Scope> =>
  Effect.acquireRelease(dockerManager.startAgent(opts), (container) =>
    // Release must never fail (Effect.acquireRelease requirement); swallow
    // cleanup errors to a log, matching the fleet's existing best-effort
    // stop semantics.
    dockerManager
      .stopAgent(container)
      .pipe(
        Effect.catchAll((err) =>
          Effect.sync(() =>
            logger.warn(
              `Failed to stop agent container "${container.name}": ${err.message}`,
            ),
          ),
        ),
      ),
  );
