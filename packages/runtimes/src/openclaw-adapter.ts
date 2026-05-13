import { Data, Effect, pipe } from "effect";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Runtime,
  RuntimeServerHandle,
  SpawnInput,
  LogSlice,
  ReadyOutcome,
} from "./runtime.js";
import { SpawnFailed } from "./errors.js";
import {
  installChannelPlugin as installSharedChannelPlugin,
  resolveChannelDependency,
  seedWorkspaceFiles as seedSharedWorkspaceFiles,
} from "./channel-plugin-install.js";
import {
  existsSync,
  makeDirectorySync,
  makeTempDirectorySync,
  removeSync,
  writeFileSync,
} from "./node-fs.js";

const OPENCLAW_TERM_WAIT_MS = 10_000;
const OPENCLAW_KILL_WAIT_MS = 5_000;
const PROCESS_GROUP_POLL_INTERVAL_MS = 100;
const DEFAULT_OPENCLAW_MODEL_ID = "openai-codex/gpt-5.4";
const TOKEN_RADIX = 36;
const JSON_INDENT_SPACES = 2;

class WorkspaceRootNotFound extends Data.TaggedError("WorkspaceRootNotFound")<{
  readonly message: string;
}> {}

class PortAllocationFailed extends Data.TaggedError("PortAllocationFailed")<{
  readonly message: string;
  readonly cause?: Error;
}> {}

export interface OpenClawAdapterDeps {
  readonly server: RuntimeServerHandle;
  readonly openclawBin: string;
  readonly channelDistDir: string;
  readonly repoRoot: string;
}

export interface WorkspaceOpenClawAdapterInput {
  readonly server: RuntimeServerHandle;
  readonly openclawBin?: string;
  readonly channelDistDir?: string;
  readonly repoRoot?: string;
}

interface AdapterState {
  child: ChildProcess;
  stateDir: string;
  logBuffer: string;
  spawnInput: SpawnInput;
  tornDown: boolean;
}

export class OpenClawAdapter implements Runtime {
  private state: AdapterState | null = null;

  constructor(private readonly deps: OpenClawAdapterDeps) {}

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
      const port = yield* allocateFreePort().pipe(
        Effect.mapError(toSpawnFailed),
      );

      yield* Effect.try({
        try: () => {
          const { deps } = this;
          const stateDir = makeTempDirectorySync(
            path.join(os.tmpdir(), `openclaw-${input.agentName}-`),
          );

          writeOpenClawConfig({
            stateDir,
            serverUrl: input.serverUrl,
            apiKey: input.apiKey,
            agentName: input.agentName,
            modelId: input.modelId,
          });
          seedWorkspaceFiles(stateDir, input.workspaceFiles);

          installChannelPlugin(stateDir, deps.channelDistDir, deps.repoRoot);

          const openclawArgs = [
            "gateway",
            "run",
            "--allow-unconfigured",
            "--port",
            String(port),
          ];
          const [command, args] = deps.openclawBin.endsWith(".mjs")
            ? ["node", [deps.openclawBin, ...openclawArgs]]
            : [deps.openclawBin, openclawArgs];

          const child = nodeSpawn(command, args, {
            cwd: stateDir,
            env: filterDefinedEnv(globalThis.process.env, {
              OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
            }),
            stdio: ["ignore", "pipe", "pipe"],
            // detached:true makes the child the leader of its own process group.
            // This lets teardown kill the entire group via process.kill(-pid, signal).
            detached: true,
          });

          const st: AdapterState = {
            child,
            stateDir,
            logBuffer: "",
            spawnInput: input,
            tornDown: false,
          };

          const onChunk = (chunk: Buffer) => {
            st.logBuffer += chunk.toString();
          };
          child.stdout?.on("data", onChunk);
          child.stderr?.on("data", onChunk);

          this.state = st;
        },
        catch: toSpawnFailed,
      });
    });
  }

  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never> {
    if (!this.state) {
      return Effect.succeed({ _tag: "Ready" as const });
    }
    const { child, spawnInput } = this.state;
    const agentId = spawnInput.agentId;

    const serverReady = this.deps.server.awaitAgentReady(agentId, timeoutMs);

    // Adapter-side `ProcessExited` detector. Polls `child.exitCode` until
    // the process exits, then returns the outcome with stderr captured
    // from the live log buffer.
    const exitTick: Effect.Effect<ReadyOutcome | null, never, never> =
      Effect.sync(() => {
        if (child.exitCode === null) return null;
        return {
          _tag: "ProcessExited" as const,
          exitCode: child.exitCode,
          stderr: this.state?.logBuffer ?? "",
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
      // Final-check: if the race resolved `Timeout`, the child may have
      // exited within the last `exitLoop` tick window — one last sync probe
      // promotes that case to `ProcessExited` with the actual exit code so
      // the diagnostic stderr isn't lost behind an opaque `Timeout`.
      Effect.flatMap(
        (outcome): Effect.Effect<ReadyOutcome, never, never> =>
          outcome._tag !== "Timeout"
            ? Effect.succeed(outcome)
            : Effect.sync(
                (): ReadyOutcome =>
                  child.exitCode !== null
                    ? {
                        _tag: "ProcessExited" as const,
                        exitCode: child.exitCode,
                        stderr: this.state?.logBuffer ?? "",
                      }
                    : outcome,
              ),
      ),
      // Failure outcomes (Timeout, ProcessExited) tear down before returning.
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
    const text = this.state.logBuffer.slice(offset);
    return { text, nextOffset: this.state.logBuffer.length };
  }

  getInboundMarker(): string {
    return "inbound from agent:";
  }

  private doTeardown(): Effect.Effect<void, never, never> {
    return Effect.gen(this, function* () {
      const teardownState = yield* Effect.sync(() => {
        const state = this.state;
        if (!state || state.tornDown) return null;
        state.tornDown = true;
        return { child: state.child, stateDir: state.stateDir };
      });

      if (teardownState === null) return;

      const { child, stateDir } = teardownState;
      const groupId = child.pid ?? null;

      if (groupId !== null) {
        this.killGroup(groupId, "SIGTERM");
        const exitedAfterTerm = yield* this.waitForProcessGroupExit(
          groupId,
          OPENCLAW_TERM_WAIT_MS,
        );
        if (!exitedAfterTerm) {
          this.killGroup(groupId, "SIGKILL");
          yield* this.waitForProcessGroupExit(groupId, OPENCLAW_KILL_WAIT_MS);
        }
      }

      yield* Effect.try({
        try: () => removeSync(stateDir, { recursive: true, force: true }),
        catch: (cause) => cause,
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning(
            "failed to remove OpenClaw adapter state dir",
            cause,
          ),
        ),
      );
    });
  }

  private waitForProcessGroupExit(
    groupId: number,
    timeoutMs: number,
  ): Effect.Effect<boolean, never, never> {
    const deadline = Date.now() + timeoutMs;
    const poll = (): Effect.Effect<boolean, never, never> =>
      Effect.sync(() => this.isProcessGroupAlive(groupId)).pipe(
        Effect.flatMap((alive) => {
          if (!alive) {
            return Effect.succeed(true);
          }
          if (Date.now() >= deadline) {
            return Effect.succeed(false);
          }
          return Effect.sleep(`${PROCESS_GROUP_POLL_INTERVAL_MS} millis`).pipe(
            Effect.flatMap(() => poll()),
          );
        }),
      );
    return poll();
  }

  private isProcessGroupAlive(groupId: number): boolean {
    try {
      process.kill(-groupId, 0);
      return true;
    } catch (error) {
      return !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      );
    }
  }

  private killGroup(groupId: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-groupId, signal);
    } catch (killErr) {
      process.stderr.write(
        `failed to signal OpenClaw process group ${String(killErr)}\n`,
      );
    }
  }
}

export function createWorkspaceOpenClawAdapter(
  input: WorkspaceOpenClawAdapterInput,
): OpenClawAdapter {
  const packageRoot = resolveWorkspacePackageRoot();
  const repoRoot = input.repoRoot ?? path.dirname(path.dirname(packageRoot));
  return new OpenClawAdapter({
    server: input.server,
    openclawBin:
      input.openclawBin ?? resolveWorkspaceOpenClawBin(packageRoot, repoRoot),
    channelDistDir:
      input.channelDistDir ??
      path.join(repoRoot, "packages/openclaw-channel/dist"),
    repoRoot,
  });
}

// --- Module-private helpers ---

function resolveWorkspacePackageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.parse(current).root) {
    if (path.basename(current) === "packages") {
      return path.join(current, "runtimes");
    }
    current = path.dirname(current);
  }
  throw new WorkspaceRootNotFound({
    message: "Unable to resolve packages/runtimes workspace root",
  });
}

function resolveWorkspaceOpenClawBin(
  packageRoot: string,
  repoRoot: string,
): string {
  const packageBin = path.join(packageRoot, "node_modules/.bin/openclaw");
  if (existsSync(packageBin)) {
    return packageBin;
  }
  return path.join(repoRoot, "node_modules/.bin/openclaw");
}

function allocateFreePort(): Effect.Effect<
  number,
  PortAllocationFailed,
  never
> {
  return Effect.async<number, PortAllocationFailed>((resume) => {
    const server = net.createServer();
    let settled = false;
    const settle = (
      effect: Effect.Effect<number, PortAllocationFailed>,
      closeServer = true,
    ): void => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (closeServer) {
        server.close();
      }
      resume(effect);
    };
    server.listen(0, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        settle(
          Effect.fail(
            new PortAllocationFailed({
              message: "Unable to allocate TCP port",
            }),
          ),
        );
        return;
      }
      const port = addr.port;
      server.close((closeErr) =>
        closeErr
          ? settle(
              Effect.fail(
                new PortAllocationFailed({
                  message: closeErr.message,
                  cause: closeErr,
                }),
              ),
              false,
            )
          : settle(Effect.succeed(port), false),
      );
    });
    server.on("error", (err) =>
      settle(
        Effect.fail(
          new PortAllocationFailed({
            message: err.message,
            cause: err,
          }),
        ),
      ),
    );
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      server.close();
    });
  });
}

function filterDefinedEnv(
  source: NodeJS.ProcessEnv,
  extras: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extras)) {
    out[key] = value;
  }
  return out;
}

// --- Config and plugin install (module-private) ---

interface OpenClawConfig {
  agents: {
    defaults: {
      model: { primary: string };
      workspace: string;
      compaction: { mode: string };
    };
  };
  commands: { native: string; nativeSkills: string; restart: boolean };
  messages: {
    queue: { mode: string; debounceMs: number; cap: number; drop: string };
  };
  channels: {
    moltzap: {
      accounts: Array<{
        id: string;
        apiKey: string;
        serverUrl: string;
        agentName: string;
      }>;
    };
  };
  gateway: {
    mode: string;
    auth: { mode: string; token: string };
  };
}

function writeOpenClawConfig(opts: {
  stateDir: string;
  serverUrl: string;
  apiKey: string;
  agentName: string;
  modelId?: string;
}): void {
  const serverUrl = opts.serverUrl
    .replace(/\/ws$/, "")
    .replace(/^ws:/, "http:");

  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: opts.modelId ?? DEFAULT_OPENCLAW_MODEL_ID },
        workspace: path.join(opts.stateDir, "workspace"),
        compaction: { mode: "safeguard" },
      },
    },
    commands: { native: "auto", nativeSkills: "auto", restart: true },
    messages: {
      queue: { mode: "queue", debounceMs: 0, cap: 100, drop: "new" },
    },
    channels: {
      moltzap: {
        accounts: [
          {
            id: "default",
            apiKey: opts.apiKey,
            serverUrl,
            agentName: opts.agentName,
          },
        ],
      },
    },
    gateway: {
      mode: "local",
      auth: {
        mode: "token",
        token: `runtime-${Date.now().toString(TOKEN_RADIX)}`,
      },
    },
  };

  makeDirectorySync(path.join(opts.stateDir, "workspace"));
  makeDirectorySync(path.join(opts.stateDir, "logs"));
  writeFileSync(
    path.join(opts.stateDir, "openclaw.json"),
    JSON.stringify(config, null, JSON_INDENT_SPACES),
  );
}

function seedWorkspaceFiles(
  stateDir: string,
  workspaceFiles: SpawnInput["workspaceFiles"],
): void {
  seedSharedWorkspaceFiles(stateDir, workspaceFiles);
}

function installChannelPlugin(
  stateDir: string,
  channelDistDir: string,
  repoRoot: string,
): void {
  const channelPackageDir = path.dirname(channelDistDir);
  // OpenClaw's plugin imports `effect` at load time. Resolve it the way
  // Node would when the channel package itself imported it (#285) — that
  // walks parent `node_modules` directories, so it handles both per-pkg
  // installs (`<pkg>/node_modules/effect`) and workspace hoists
  // (`<repoRoot>/node_modules/effect`). The legacy `dist/node_modules`
  // candidate is kept as a fallback for any consumer that still ships a
  // bundled artifact in that layout.
  const effectResolved = resolveChannelDependency(channelPackageDir, "effect");
  installSharedChannelPlugin({
    stateDir,
    channelDistDir,
    repoRoot,
    extName: "openclaw-channel",
    // OpenClaw discovers channels via `openclaw.plugin.json` in the
    // package root; cc-channel has no equivalent manifest.
    extraPackageFiles: ["openclaw.plugin.json"],
    extraSymlinks: [
      {
        linkPath: "effect",
        candidates: [
          ...(effectResolved === null ? [] : [effectResolved]),
          path.join(channelDistDir, "node_modules", "effect"),
        ],
      },
    ],
  });
}
