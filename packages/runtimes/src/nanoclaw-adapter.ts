import { Effect } from "effect";

import type {
  Runtime,
  RuntimeServerHandle,
  SpawnInput,
  LogSlice,
  ReadyOutcome,
} from "./runtime.js";
import { SpawnFailed } from "./errors.js";
import {
  ensureNanoclawRuntimeInstalled,
  startNanoclawRuntime,
  stopNanoclawRuntime,
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

export class NanoclawAdapter implements Runtime {
  private state: AdapterState | null = null;

  constructor(private readonly deps: NanoclawAdapterDeps) {}

  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never> {
    return Effect.tryPromise({
      // #ignore-sloppy-code-next-line[async-keyword, promise-type]: nanoclaw runtime install + subprocess spawn boundary
      try: async () => {
        await ensureNanoclawRuntimeInstalled();
        const handle = await startNanoclawRuntime({
          apiKey: input.apiKey,
          serverUrl: input.serverUrl,
          workspaceFiles: input.workspaceFiles,
        });
        this.state = { handle, spawnInput: input, tornDown: false };
      },
      catch: (cause) =>
        new SpawnFailed(
          input.agentName,
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
    });
  }

  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never> {
    return Effect.async<ReadyOutcome, never, never>((resume) => {
      if (!this.state) {
        resume(Effect.succeed({ _tag: "Ready" as const }));
        return;
      }

      const deadline = Date.now() + timeoutMs;
      const { handle, spawnInput } = this.state;
      const agentId = spawnInput.agentId;

      const check = () => {
        if (handle.proc.exitCode !== null) {
          const stderr = getNanoclawRuntimeLogs(handle);
          this.runTeardown();
          resume(
            Effect.succeed({
              _tag: "ProcessExited" as const,
              exitCode: handle.proc.exitCode,
              stderr,
            }),
          );
          return;
        }

        const connections = this.deps.server.connections.getByAgent(agentId);
        if (connections.length > 0 && connections[0]!.auth !== null) {
          resume(Effect.succeed({ _tag: "Ready" as const }));
          return;
        }

        if (Date.now() > deadline) {
          this.runTeardown();
          resume(Effect.succeed({ _tag: "Timeout" as const, timeoutMs }));
          return;
        }

        setTimeout(check, 500);
      };

      check();
    });
  }

  teardown(): Effect.Effect<void, never, never> {
    // #ignore-sloppy-code-next-line[effect-promise]: doTeardown is internally guarded — torn-down flag prevents double-run, errors are swallowed by design
    return Effect.promise(() => this.doTeardown());
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

  // #ignore-sloppy-code-next-line[async-keyword, promise-type]: nanoclaw runtime teardown boundary
  private async doTeardown(): Promise<void> {
    if (!this.state || this.state.tornDown) return;
    this.state.tornDown = true;
    await stopNanoclawRuntime(this.state.handle);
  }

  private runTeardown(): void {
    // #ignore-sloppy-code-next-line[promise-type]: fire-and-forget cleanup — resume callback cannot await
    void this.doTeardown();
  }
}
