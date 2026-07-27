/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { NodeContext } from "@effect/platform-node";
import { Effect, Fiber } from "effect";

import type {
  Runtime,
  RuntimeServerHandle,
  SpawnInput,
  LogSlice,
  ReadyOutcome,
} from "./runtime.js";
import { SpawnFailed, spawnFailed } from "./errors.js";
import { raceReadiness } from "./adapter-readiness.js";
import { pollFiberExitCode } from "./child-process.js";
import {
  startNanoclawRuntimeEffect,
  stopNanoclawRuntimeEffect,
  type NanoclawRuntimeHandle,
} from "./nanoclaw-process.js";
import { ensureNanoclawRuntimeInstalledEffect } from "./nanoclaw-install.js";
import { type InstallMode } from "./install-mode.js";

export interface NanoclawAdapterOptions {
  readonly server: RuntimeServerHandle;
  readonly installMode: InstallMode;

  /**
   * Registers conversations on first delivery so NanoClaw will process them.
   * Defaults to `false`; enable it only for disposable testbeds that should
   * accept conversations without a pre-provisioned NanoClaw registration.
   */
  readonly autoRegisterConversations?: boolean;

  /**
   * Stdio MCP servers wired into the container workspace as `.mcp.json`
   * (the container-mount half of the simulator's Environment contract).
   */
  readonly mcpServers?: ReadonlyArray<{
    readonly name: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
  }>;

  /** Model identifier honored per spawn; `SpawnInput.modelId` takes precedence. */
  readonly modelId?: string;
}

interface AdapterState {
  handle: NanoclawRuntimeHandle;
  spawnInput: SpawnInput;
  teardown: Effect.Effect<void, never, never>;
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
  options: NanoclawAdapterOptions,
) {
  const install = yield* ensureNanoclawRuntimeInstalledEffect(
    options.installMode,
  );
  return yield* startNanoclawRuntimeEffect(
    {
      agentName: input.agentName,
      agentId: input.agentId,
      apiKey: input.apiKey,
      serverUrl: input.serverUrl,
      workspaceFiles: input.workspaceFiles,
      autoRegisterConversations: options.autoRegisterConversations ?? false,
      modelId: input.modelId ?? options.modelId,
      mcpServers: options.mcpServers,
    },
    install,
  );
});

/**
 * Nanoclaw runtime adapter. Runs agent subprocesses inside Docker
 * containers via the OneCLI gateway. Two-phase startup: ensure the
 * runtime cache is installed, then launch.
 *
 * ```mermaid
 * flowchart TD
 *   NS["NanoclawAdapter.spawn(input)"]
 *   subgraph P1["Install pinned NanoClaw runtime"]
 *     P1M{"install mode"}
 *     P1P["published<br>hash bundled exact registry lock"]
 *     P1WSRC["workspace<br>pack built client + protocol<br>hash exact tarball bytes"]
 *     P1C{"matching immutable generation exists?"}
 *     P1WARM["reuse immutable generation"]
 *     P1COLD["preflight Docker → download pinned source<br>→ copy bundled channel + skill + eval provisioner"]
 *     P1CM{"workspace?"}
 *     P1VENDOR["copy tarballs into vendor<br>rewrite both direct deps to file paths<br>refresh + assert package lock"]
 *     P1BUILD["npm ci + build<br>build fingerprinted Docker image<br>publish immutable generation"]
 *     P1M -->|published| P1P --> P1C
 *     P1M -->|workspace| P1WSRC --> P1C
 *     P1C -->|yes| P1WARM
 *     P1C -->|no| P1COLD --> P1CM
 *     P1CM -->|yes| P1VENDOR --> P1BUILD
 *     P1CM -->|no| P1BUILD
 *   end
 *   subgraph P2["Start isolated agent runtime"]
 *     P2DIR["create isolated runtime dir<br>copy container + scripts"]
 *     P2OC["ensureOnecliRunning<br>(probe 10254; up if unreachable)"]
 *     P2WS["write agent-local workspace files + profile"]
 *     P2EVAL["eval mode only<br>seed agent group + container config"]
 *     P2SP["startNanoclawProcess<br>(absolute cached entrypoint,<br>isolated runtime cwd)"]
 *     P2OC --> P2DIR --> P2WS --> P2EVAL --> P2SP
 *   end
 *   NCR["waitUntilReady — server.awaitAgentReady (WS auth)<br>raced against subprocess exit,<br>bounded by the caller's readyTimeoutMs"]
 *   NS --> P1M
 *   P1WARM --> P2OC
 *   P1BUILD --> P2OC
 *   P2SP --> NCR
 * ```
 *
 * Inbound marker: `New messages`. The immutable cache key covers the pinned
 * NanoClaw source, dependency lock, bundled channel/skill/provisioner, host
 * ABI, and workspace tarball bytes when workspace mode is selected.
 */
export class NanoclawAdapter implements Runtime {
  private state: AdapterState | null = null;

  constructor(private readonly options: NanoclawAdapterOptions) {}

  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never> {
    return this.launchRuntime(input).pipe(
      Effect.mapError((cause) => spawnFailed(input.agentName, cause)),
      Effect.provide(NodeContext.layer),
    );
  }

  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never> {
    if (!this.state) {
      return Effect.succeed({ _tag: "Ready" as const });
    }
    const { handle, spawnInput } = this.state;
    return raceReadiness({
      serverReady: this.options.server.awaitAgentReady(
        spawnInput.agentId,
        timeoutMs,
      ),
      source: {
        pollExitCode: () => pollFiberExitCode(handle.exitFiber),
        stderr: () => handle.logs.text,
        timeoutMs,
      },
      teardown: () => this.teardown(),
    });
  }

  teardown(): Effect.Effect<void, never, never> {
    return this.state?.teardown ?? Effect.void;
  }

  getLogs(offset: number): LogSlice {
    if (!this.state) return { text: "", nextOffset: 0 };
    return this.state.handle.logs.read(offset);
  }

  getInboundMarker(): string {
    return "New messages";
  }

  /** Resolves once, on the runtime process's exit (the simulator's ongoing exit signal). */
  awaitExit(): Effect.Effect<
    { readonly exitCode: number | null; readonly signal: string | undefined },
    never,
    never
  > {
    const state = this.state;
    if (!state) {
      return Effect.succeed({ exitCode: null, signal: undefined });
    }
    return Fiber.join(state.handle.exitFiber).pipe(
      Effect.map((exitCode) =>
        exitCode >= 0
          ? { exitCode, signal: undefined }
          : { exitCode: null, signal: undefined },
      ),
    );
  }

  private launchRuntime(input: SpawnInput) {
    const lease = { committed: false };
    return Effect.uninterruptibleMask((restore) =>
      Effect.scoped(
        Effect.gen(this, function* () {
          const handle = yield* Effect.acquireRelease(
            restore(acquireNanoclawRuntime(input, this.options)),
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
