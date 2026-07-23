/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
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
  startNanoclawRuntimeEffect,
  stopNanoclawRuntimeEffect,
  getNanoclawRuntimeLogs,
  type NanoclawRuntimeHandle,
} from "./nanoclaw-process.js";
import { ensureNanoclawRuntimeInstalledEffect } from "./nanoclaw-install.js";

export interface NanoclawAdapterOptions {
  readonly server: RuntimeServerHandle;

  /**
   * Registers conversations on first delivery so NanoClaw will process them.
   * Defaults to `false`; enable it only for disposable testbeds that should
   * accept conversations without a pre-provisioned NanoClaw registration.
   */
  readonly autoRegisterConversations?: boolean;
}

interface AdapterState {
  handle: NanoclawRuntimeHandle;
  spawnInput: SpawnInput;
  teardown: Effect.Effect<void, never, never>;
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

function stopNanoclawRuntimeSafely(
  handle: NanoclawRuntimeHandle,
  failureMessage: string,
): Effect.Effect<void, never, never> {
  return stopNanoclawRuntimeEffect(handle).pipe(
    Effect.provide(NodeContext.layer),
    Effect.catchAll((cause) => Effect.logWarning(failureMessage, cause)),
  );
}

const acquireNanoclawRuntime = Effect.fn("NanoclawAdapter.acquire")(function* (
  input: SpawnInput,
  autoRegisterConversations: boolean,
) {
  const install = yield* ensureNanoclawRuntimeInstalledEffect();
  return yield* startNanoclawRuntimeEffect(
    {
      agentName: input.agentName,
      agentId: input.agentId,
      apiKey: input.apiKey,
      serverUrl: input.serverUrl,
      workspaceFiles: input.workspaceFiles,
      autoRegisterConversations,
    },
    install,
  );
});

function spawnFailedFor(input: SpawnInput, cause: unknown): SpawnFailed {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return new SpawnFailed({
    agentName: input.agentName,
    cause: error,
    message: `Failed to spawn agent "${input.agentName}": ${error.message}`,
  });
}

/**
 * Nanoclaw runtime adapter. Runs agent subprocesses inside Docker
 * containers via the OneCLI gateway. Two-phase startup: ensure the
 * runtime cache is installed, then launch.
 *
 * ```mermaid
 * flowchart TD
 *   NS["NanoclawAdapter.spawn(input)"]
 *   subgraph P1["Install pinned NanoClaw runtime"]
 *     P1C{"matching immutable generation exists?"}
 *     P1WARM["reuse immutable generation"]
 *     P1COLD["preflightDocker → download pinned tarball<br>→ copy bundled channel + skill<br>→ install pinned client + build<br>→ publish immutable generation"]
 *     P1C -->|yes| P1WARM
 *     P1C -->|no| P1COLD
 *   end
 *   subgraph P2["Start isolated agent runtime"]
 *     P2DIR["create isolated runtime dir<br>copy container + scripts"]
 *     P2OC["ensureOnecliRunning<br>(probe 10254; up if unreachable)"]
 *     P2WS["write agent-local workspace files + profile"]
 *     P2SP["startNanoclawProcess<br>(absolute cached entrypoint,<br>isolated runtime cwd)"]
 *     P2WAIT["waitForNanoclawConnection<br>(scan logs for CONNECTED_MARKER)"]
 *     P2DIR --> P2OC --> P2WS --> P2SP --> P2WAIT
 *   end
 *   NCR["waitUntilReady — TWO gates:<br>1. inner: waitForNanoclawConnection (stdout marker)<br>2. outer: server.awaitAgentReady (WS auth)"]
 *   NS --> P1 --> P2 --> NCR
 * ```
 *
 * Inbound marker: `New messages`. The immutable cache key covers the pinned
 * NanoClaw source, dependency lock, bundled channel/skill, and host ABI.
 */
export class NanoclawAdapter implements Runtime {
  private state: AdapterState | null = null;

  constructor(private readonly options: NanoclawAdapterOptions) {}

  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never> {
    return this.launchRuntime(input).pipe(
      Effect.mapError((cause) => spawnFailedFor(input, cause)),
      Effect.provide(NodeContext.layer),
    );
  }

  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never> {
    if (!this.state) {
      return Effect.succeed({ _tag: "Ready" as const });
    }
    const { handle, spawnInput } = this.state;
    const agentId = spawnInput.agentId;

    const serverReady = this.options.server.awaitAgentReady(agentId, timeoutMs);
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
    return this.state?.teardown ?? Effect.void;
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

  private launchRuntime(input: SpawnInput) {
    const lease = { committed: false };
    return Effect.uninterruptibleMask((restore) =>
      Effect.scoped(
        Effect.gen(this, function* () {
          const handle = yield* Effect.acquireRelease(
            restore(
              acquireNanoclawRuntime(
                input,
                this.options.autoRegisterConversations ?? false,
              ),
            ),
            (acquired) =>
              lease.committed
                ? Effect.void
                : stopNanoclawRuntimeSafely(
                    acquired,
                    "failed to release uncommitted NanoClaw runtime",
                  ),
          );
          const teardown = yield* Effect.cached(
            stopNanoclawRuntimeSafely(
              handle,
              "failed to tear down NanoClaw runtime",
            ),
          );
          yield* Effect.sync(() => {
            this.state = { handle, spawnInput: input, teardown };
            lease.committed = true;
          });
        }),
      ),
    );
  }
}
