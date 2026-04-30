import { Effect, pipe } from "effect";

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
    if (!this.state) {
      return Effect.succeed({ _tag: "Ready" as const });
    }
    const { handle, spawnInput } = this.state;
    const agentId = spawnInput.agentId;

    const serverReady = this.deps.server.awaitAgentReady(agentId, timeoutMs);

    // Adapter-side `ProcessExited` detector. Polls the nanoclaw subprocess'
    // exit code until it terminates, then surfaces stderr from the runtime's
    // log accumulator.
    const exitTick: Effect.Effect<ReadyOutcome | null, never, never> =
      Effect.sync(() => {
        if (handle.proc.exitCode === null) return null;
        return {
          _tag: "ProcessExited" as const,
          exitCode: handle.proc.exitCode,
          stderr: getNanoclawRuntimeLogs(handle),
        };
      });
    const exitLoop: Effect.Effect<ReadyOutcome, never, never> = pipe(
      Effect.iterate(null as ReadyOutcome | null, {
        while: (s) => s === null,
        body: () => Effect.sleep("250 millis").pipe(Effect.zipRight(exitTick)),
      }),
      Effect.map(
        (s): ReadyOutcome => s ?? { _tag: "Timeout" as const, timeoutMs },
      ),
    );

    return pipe(
      Effect.race(serverReady, exitLoop),
      // Final-check: if the race resolved `Timeout`, nanoclaw's subprocess
      // may have exited within the last `exitLoop` tick window — one last
      // sync probe promotes that case to `ProcessExited` with the actual
      // exit code so the diagnostic stderr isn't lost behind an opaque
      // `Timeout`.
      Effect.flatMap(
        (outcome): Effect.Effect<ReadyOutcome, never, never> =>
          outcome._tag !== "Timeout"
            ? Effect.succeed(outcome)
            : Effect.sync(
                (): ReadyOutcome =>
                  handle.proc.exitCode !== null
                    ? {
                        _tag: "ProcessExited" as const,
                        exitCode: handle.proc.exitCode,
                        stderr: getNanoclawRuntimeLogs(handle),
                      }
                    : outcome,
              ),
      ),
      Effect.tap((outcome) =>
        outcome._tag === "Ready" ? Effect.void : this.teardown(),
      ),
    );
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
}
