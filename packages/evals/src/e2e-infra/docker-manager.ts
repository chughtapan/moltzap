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
import {
  DockerHealthTimeoutError,
  DockerImageError,
  DockerStartError,
  DockerStopError,
} from "./types.js";

const DEFAULT_EVAL_AGENT_IMAGE = "moltzap-eval-agent:local";
const DEFAULT_GATEWAY_TIMEOUT_MS = 180_000;
const DEFAULT_CHANNEL_TIMEOUT_MS = 180_000;

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

const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export class DockerManager {
  private containers: Array<AgentContainer & { _raw: OpenClawContainer }> = [];
  private readonly imageName: string;

  constructor(opts?: { imageName?: string }) {
    this.imageName = opts?.imageName ?? DEFAULT_EVAL_AGENT_IMAGE;
  }

  /**
   * Ensure the eval agent Docker image exists, auto-building if missing.
   * Fails with `DockerImageError` when inspect misses and auto-build cannot
   * locate the monorepo root or the build script returns non-zero.
   */
  ensureImage(): Effect.Effect<void, DockerImageError> {
    return Effect.gen(this, function* () {
      const inspectOk = yield* Effect.sync(() => {
        try {
          execSync(`docker image inspect ${this.imageName}`, { stdio: "pipe" });
          return true;
        } catch (err) {
          logger.debug(
            `Docker image "${this.imageName}" inspect failed (${errMessage(
              err,
            )}); will attempt auto-build`,
          );
          return false;
        }
      });

      if (inspectOk) {
        yield* Effect.sync(() =>
          logger.info(`Docker image "${this.imageName}" verified`),
        );
        return;
      }

      yield* Effect.sync(() =>
        logger.info(
          `Docker image "${this.imageName}" not found, attempting auto-build...`,
        ),
      );

      const root = findMonorepoRoot();
      if (!root) {
        return yield* Effect.fail(
          new DockerImageError({
            imageName: this.imageName,
            message:
              `image not found and could not locate monorepo root to auto-build. ` +
              `Build manually: cd <monorepo-root> && bash packages/evals/scripts/build-eval-agent.sh`,
          }),
        );
      }

      yield* Effect.try({
        try: () =>
          execSync("bash packages/evals/scripts/build-eval-agent.sh", {
            cwd: root,
            stdio: "inherit",
          }),
        catch: (err) =>
          new DockerImageError({
            imageName: this.imageName,
            message:
              `auto-build failed in ${root}: ${errMessage(err)}. ` +
              `Try manually: cd ${root} && bash packages/evals/scripts/build-eval-agent.sh`,
          }),
      });

      yield* Effect.sync(() =>
        logger.info(`Auto-built Docker image "${this.imageName}"`),
      );
    });
  }

  startAgent(opts: {
    name: string;
    agentModelId?: string;
    moltzapServerUrl?: string;
    moltzapApiKey?: string;
    configOverride?: Record<string, unknown>;
    extraEnv?: Record<string, string>;
    workspaceFiles?: Array<{ relativePath: string; content: string }>;
  }): Effect.Effect<AgentContainer, DockerStartError> {
    return Effect.gen(this, function* () {
      const openclawConfig = opts.configOverride
        ? opts.configOverride
        : buildOpenClawConfig({
            model: {
              modelString: opts.agentModelId ?? DEFAULT_AGENT_MODEL_ID,
            } satisfies ContainerModelConfig,
            serverUrl: opts.moltzapServerUrl!,
            agentApiKey: opts.moltzapApiKey!,
            agentName: opts.name,
          });

      const envVars: Record<string, string> = { ...opts.extraEnv };
      for (const [key, value] of Object.entries(process.env)) {
        if (key.endsWith("_API_KEY") && value) {
          envVars[key] = value;
        }
      }

      yield* Effect.sync(() =>
        logger.info(`Starting agent container "${opts.name}"`),
      );

      const raw = yield* Effect.try({
        try: () =>
          startRawContainer(openclawConfig, {
            name: opts.name,
            agentName: opts.name,
            envVars,
          }),
        catch: (e) =>
          new DockerStartError({
            containerName: opts.name,
            message: `startRawContainer failed: ${errMessage(e)}`,
          }),
      });

      if (opts.workspaceFiles) {
        yield* Effect.try({
          try: () => {
            for (const file of opts.workspaceFiles!) {
              const filePath = path.join(
                raw.tmpDir,
                "workspace",
                file.relativePath,
              );
              fs.mkdirSync(path.dirname(filePath), { recursive: true });
              fs.writeFileSync(filePath, file.content);
            }
            execSync(
              `docker cp ${raw.tmpDir}/workspace/. ${raw.containerId}:${OPENCLAW_STATE_DIR}/workspace/`,
            );
            execSync(
              `docker exec -u root ${raw.containerId} sh -lc "chown -R node:node ${OPENCLAW_STATE_DIR}/workspace"`,
            );
          },
          catch: (e) =>
            new DockerStartError({
              containerName: opts.name,
              message: `workspace seeding failed: ${errMessage(e)}`,
            }),
        });
      }

      yield* Effect.tryPromise({
        try: () => waitForGateway(raw.containerId, DEFAULT_GATEWAY_TIMEOUT_MS),
        catch: (e) =>
          new DockerStartError({
            containerName: opts.name,
            message: `gateway readiness failed: ${errMessage(e)}`,
          }),
      });

      const agent: AgentContainer & { _raw: OpenClawContainer } = {
        containerId: raw.containerId,
        controlUiPort: raw.controlPort,
        name: opts.name,
        _raw: raw,
      };
      this.containers.push(agent);
      yield* Effect.sync(() =>
        logger.info(
          `Agent "${opts.name}" started (container: ${raw.containerId.slice(0, 12)}, port: ${raw.controlPort})`,
        ),
      );
      return agent;
    });
  }

  startAgentAndWait(opts: {
    name: string;
    agentModelId?: string;
    moltzapServerUrl?: string;
    moltzapApiKey?: string;
    extraEnv?: Record<string, string>;
    workspaceFiles?: Array<{ relativePath: string; content: string }>;
    connectTimeoutMs?: number;
  }): Effect.Effect<
    AgentContainer,
    DockerStartError | DockerHealthTimeoutError
  > {
    return Effect.gen(this, function* () {
      const container = yield* this.startAgent(opts);
      const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS;
      yield* Effect.tryPromise({
        try: () => waitForChannel(container.containerId, timeoutMs),
        catch: (e) =>
          new DockerHealthTimeoutError({
            containerName: opts.name,
            timeoutMs,
            message: `channel readiness failed: ${errMessage(e)}`,
          }),
      });
      return container;
    });
  }

  stopAgent(agent: AgentContainer): Effect.Effect<void, DockerStopError> {
    return Effect.try({
      try: () => {
        const entry = this.containers.find((c) => c === agent);
        if (entry) stopRawContainer(entry._raw);
        this.containers = this.containers.filter((c) => c !== agent);
      },
      catch: (e) =>
        new DockerStopError({
          containerName: agent.name,
          message: errMessage(e),
        }),
    });
  }

  /** Best-effort: logs and swallows per-container stop failures so a single
   * bad container cannot block cleanup of the rest. */
  stopAll(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      yield* Effect.sync(() =>
        logger.info(`Stopping ${this.containers.length} agent container(s)`),
      );
      for (const c of this.containers) {
        yield* Effect.try({
          try: () => stopRawContainer(c._raw),
          catch: (e) =>
            new DockerStopError({
              containerName: c.name,
              message: errMessage(e),
            }),
        }).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() =>
              logger.warn(
                `stop failed for container "${err.containerName}": ${err.message}`,
              ),
            ),
          ),
        );
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
  DockerImageError | DockerStartError
> =>
  Effect.gen(function* () {
    const modelId = opts.modelId ?? DEFAULT_AGENT_MODEL_ID;
    const dockerManager = new DockerManager();
    yield* dockerManager.ensureImage();

    // Concurrent startup. On partial failure, already-started containers are
    // stopped before the error is rethrown.
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
    ).pipe(Effect.tapError(() => dockerManager.stopAll()));

    return { dockerManager, containers };
  });

/**
 * Effect-native scoped agent container. Use with `Effect.scoped` so the
 * container is guaranteed to stop even if the wrapped work fails or is
 * interrupted.
 */
export const scopedAgent = (
  dockerManager: DockerManager,
  opts: Parameters<DockerManager["startAgent"]>[0],
): Effect.Effect<AgentContainer, DockerStartError, Scope.Scope> =>
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
