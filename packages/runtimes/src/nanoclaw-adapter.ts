import { NodeContext } from "@effect/platform-node";
import { Effect, Exit, Fiber, Option, pipe } from "effect";

import type {
  Runtime,
  RuntimeServerHandle,
  SpawnInput,
  LogSlice,
  ReadyOutcome,
} from "./runtime.js";
import { SpawnFailed } from "./errors.js";
import {
  processExitLoop,
  promoteTimeoutIfProcessExited,
} from "./adapter-readiness.js";
import {
  ensureNanoclawRuntimeInstalledEffect,
  startNanoclawRuntimeEffect,
  stopNanoclawRuntimeEffect,
  getNanoclawRuntimeLogs,
  type NanoclawRuntimeHandle,
} from "./nanoclaw-process.js";

export interface NanoclawAdapterDeps {
  readonly server: RuntimeServerHandle;
  readonly nanoclawCache?: string;
}

interface AdapterState {
  handle: NanoclawRuntimeHandle;
  spawnInput: SpawnInput;
  tornDown: boolean;
}

function exitToCode(exit: Exit.Exit<number, never>): number {
  return Exit.match(exit, {
    onSuccess: (code) => code,
    onFailure: () => -1,
  });
}

function pollNanoclawExitCode(
  handle: NanoclawRuntimeHandle,
): Effect.Effect<Option.Option<number>, never, never> {
  return Fiber.poll(handle.exitFiber).pipe(Effect.map(Option.map(exitToCode)));
}

/**
 * Nanoclaw runtime adapter. Runs agent subprocesses inside Docker
 * containers via the OneCLI gateway. Two-phase startup: ensure the
 * runtime cache is installed, then launch.
 *
 * ```mermaid
 * flowchart TD
 *   NS["NanoclawAdapter.spawn(input)"]
 *   subgraph P1["Phase 1 — ensureNanoclawRuntimeInstalledEffect"]
 *     P1C{".ready exists?"}
 *     P1WARM["syncChannelFileIntoCache&lt;br>(diff channel + client/dist; rebuild if drifted)"]
 *     P1COLD["preflightDocker → downloadTarball&lt;br>→ copy channel + barrel + skill&lt;br>→ buildNanoclawRuntimeCache&lt;br>→ promoteRuntimeCache"]
 *     P1C -->|warm| P1WARM
 *     P1C -->|cold| P1COLD
 *   end
 *   subgraph P2["Phase 2 — startNanoclawRuntimeEffect"]
 *     P2DIR[createNanoclawDataDir]
 *     P2OC["ensureOnecliRunning&lt;br>(probe 10254; up if unreachable)"]
 *     P2WS[writeRuntimeWorkspaceFiles]
 *     P2SP["startNanoclawProcess&lt;br>(node dist/index.js + ONECLI_URL env)"]
 *     P2WAIT["waitForNanoclawConnection&lt;br>(scan logs for CONNECTED_MARKER)"]
 *     P2DIR --> P2OC --> P2WS --> P2SP --> P2WAIT
 *   end
 *   NCR["waitUntilReady — TWO gates:&lt;br>1. inner: waitForNanoclawConnection (stdout marker)&lt;br>2. outer: server.awaitAgentReady (WS auth)"]
 *   NS --> P1 --> P2 --> NCR
 * ```
 *
 * Inbound marker: `New messages`. Cache lives at
 * `NANOCLAW_RUNTIME_CACHE`; the channel-file sync detects drift in
 * the moltzap channel + client-dist files and rebuilds.
 */
export class NanoclawAdapter implements Runtime {
  private state: AdapterState | null = null;

  constructor(private readonly deps: NanoclawAdapterDeps) {}

  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never> {
    const toSpawnFailed = (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return new SpawnFailed({
        agentName: input.agentName,
        cause: error,
        message: `Failed to spawn agent "${input.agentName}": ${error.message}`,
      });
    };

    return Effect.gen(this, function* () {
      yield* ensureNanoclawRuntimeInstalledEffect();

      const handle = yield* startNanoclawRuntimeEffect({
        apiKey: input.apiKey,
        serverUrl: input.serverUrl,
        workspaceFiles: input.workspaceFiles,
      });

      yield* Effect.sync(() => {
        this.state = { handle, spawnInput: input, tornDown: false };
      });
    }).pipe(Effect.mapError(toSpawnFailed), Effect.provide(NodeContext.layer));
  }

  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never> {
    if (!this.state) {
      return Effect.succeed({ _tag: "Ready" as const });
    }
    const { handle, spawnInput } = this.state;
    const agentId = spawnInput.agentId;

    const serverReady = this.deps.server.awaitAgentReady(agentId, timeoutMs);
    const processExit = {
      pollExitCode: () => pollNanoclawExitCode(handle),
      stderr: () => getNanoclawRuntimeLogs(handle),
      timeoutMs,
    };

    return pipe(
      Effect.race(serverReady, processExitLoop(processExit)),
      // Final-check: if the race resolved `Timeout`, nanoclaw's subprocess
      // may have exited within the last `exitLoop` tick window — one last
      // sync probe promotes that case to `ProcessExited` with the actual
      // exit code so the diagnostic stderr isn't lost behind an opaque
      // `Timeout`.
      Effect.flatMap((outcome) =>
        promoteTimeoutIfProcessExited(outcome, processExit),
      ),
      Effect.tap((outcome) =>
        outcome._tag === "Ready" ? Effect.void : this.teardown(),
      ),
    );
  }

  teardown(): Effect.Effect<void, never, never> {
    return this.doTeardown();
  }

  getLogs(offset: number): LogSlice {
    if (!this.state) return { text: "", nextOffset: 0 };
    const full = getNanoclawRuntimeLogs(this.state.handle);
    const text = full.slice(offset);
    return { text, nextOffset: full.length };
  }

  getInboundMarker(): string {
    return "New messages";
  }

  private doTeardown(): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const state = this.state;
      if (!state || state.tornDown) return null;
      state.tornDown = true;
      return state.handle;
    }).pipe(
      Effect.flatMap((handle) =>
        handle === null
          ? Effect.void
          : stopNanoclawRuntimeEffect(handle).pipe(
              Effect.provide(NodeContext.layer),
              Effect.catchAll(() => Effect.void),
            ),
      ),
    );
  }
}
