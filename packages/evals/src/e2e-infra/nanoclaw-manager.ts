/**
 * Manages nanoclaw processes for E2E evals.
 *
 * Each agent is a separate nanoclaw subprocess sharing a cached binary
 * and OneCLI gateway. Mirrors DockerManager's API surface.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Effect } from "effect";
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

/**
 * Internal Effect helpers. Public API remains Promise-returning for
 * compatibility with the agent-fleet wrapper; the orchestration layer
 * here is Effect-native so the Promise-thrashing is localized.
 */
const ensureInstalledEffect: Effect.Effect<void, Error> = Effect.tryPromise({
  try: () => ensureNanoclawInstalled(),
  catch: (err) => (err instanceof Error ? err : new Error(String(err))),
});

const startNanoclawSmokeEffect = (opts: {
  apiKey: string;
  serverUrl: string;
}): Effect.Effect<NanoclawSmokeHandle, Error> =>
  Effect.tryPromise({
    try: () => startNanoclawSmoke(opts),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });

const stopNanoclawSmokeEffect = (
  handle: NanoclawSmokeHandle,
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () => stopNanoclawSmoke(handle),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });

export class NanoclawManager {
  private agents: NanoclawAgent[] = [];

  // #ignore-sloppy-code-next-line[promise-type]: NanoclawManager public API mirrors DockerManager — Promise-based
  ensureInstalled(): Promise<void> {
    return Effect.runPromise(ensureInstalledEffect);
  }

  /**
   * Start one nanoclaw agent. Writes workspace files into the cache tree
   * before spawning so the subcontainer launch picks them up.
   */
  startAgent(opts: {
    name: string;
    apiKey: string;
    serverUrl: string;
    workspaceFiles?: Array<{ relativePath: string; content: string }>;
    // #ignore-sloppy-code-next-line[promise-type]: NanoclawManager public API mirrors DockerManager
  }): Promise<NanoclawAgent> {
    return Effect.runPromise(this.startAgentEffect(opts));
  }

  private startAgentEffect(opts: {
    name: string;
    apiKey: string;
    serverUrl: string;
    workspaceFiles?: Array<{ relativePath: string; content: string }>;
  }): Effect.Effect<NanoclawAgent, Error> {
    return Effect.gen(this, function* () {
      yield* Effect.sync(() =>
        logger.info(`Starting nanoclaw agent "${opts.name}"`),
      );

      // Write workspace files into the nanoclaw cache's container tree.
      // Skills are volume-mounted at runtime (not baked into the image),
      // so changes here are visible to the next subcontainer launch.
      if (opts.workspaceFiles) {
        yield* Effect.sync(() => {
          for (const file of opts.workspaceFiles!) {
            const destPath = path.join(
              NANOCLAW_CACHE,
              "container/skills",
              file.relativePath,
            );
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.writeFileSync(destPath, file.content);
          }
        });
      }

      const handle = yield* startNanoclawSmokeEffect({
        apiKey: opts.apiKey,
        serverUrl: opts.serverUrl,
      });
      const agent: NanoclawAgent = { name: opts.name, handle };
      this.agents.push(agent);
      yield* Effect.sync(() =>
        logger.info(`Nanoclaw agent "${opts.name}" connected`),
      );
      return agent;
    });
  }

  // #ignore-sloppy-code-next-line[promise-type]: NanoclawManager public API mirrors DockerManager
  stopAgent(agent: NanoclawAgent): Promise<void> {
    return Effect.runPromise(
      this.safeStopEffect(agent).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.agents = this.agents.filter((a) => a !== agent);
          }),
        ),
      ),
    );
  }

  // #ignore-sloppy-code-next-line[promise-type]: NanoclawManager public API mirrors DockerManager
  stopAll(): Promise<void> {
    const agents = [...this.agents];
    this.agents = [];
    // Parallel stop with bounded concurrency: we don't want to open too many
    // docker/OneCLI RPCs at once, but serial cleanup is slow for large fleets.
    // Each stop swallows its own error (fleet shutdown is best-effort).
    return Effect.runPromise(
      Effect.sync(() =>
        logger.info(`Stopping ${agents.length} nanoclaw agent(s)`),
      ).pipe(
        Effect.flatMap(() =>
          Effect.forEach(agents, (a) => this.safeStopEffect(a), {
            concurrency: 4,
            discard: true,
          }),
        ),
      ),
    );
  }

  /** Stop one agent, swallowing errors into a warn log (fleet shutdown is best-effort). */
  private safeStopEffect(agent: NanoclawAgent): Effect.Effect<void, never> {
    return stopNanoclawSmokeEffect(agent.handle).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() =>
          logger.warn(
            `Failed to stop nanoclaw agent "${agent.name}": ${err instanceof Error ? err.message : String(err)}`,
          ),
        ),
      ),
    );
  }

  getAgentLogs(agent: NanoclawAgent): string {
    return getNanoclawLogs(agent.handle);
  }
}
