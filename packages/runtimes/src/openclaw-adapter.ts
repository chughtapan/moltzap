import { Command, FileSystem, Path, SocketServer } from "@effect/platform";
import type { Process, Signal } from "@effect/platform/CommandExecutor";
import { Data, Effect, Exit, Fiber, Option, Scope, Stream, pipe } from "effect";
import { NodeContext, NodeSocketServer } from "@effect/platform-node";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

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
import { resolveWorkspaceOpenClawBin } from "./package-resolution.js";

const OPENCLAW_TERM_WAIT_MS = 10_000;
const OPENCLAW_KILL_WAIT_MS = 5_000;
const DEFAULT_OPENCLAW_MODEL_ID = "openai-codex/gpt-5.4";
const TOKEN_RADIX = 36;
const JSON_INDENT_SPACES = 2;

class WorkspaceRootNotFound extends Data.TaggedError("WorkspaceRootNotFound")<{
  readonly message: string;
}> {}

class PortAllocationFailed extends Data.TaggedError("PortAllocationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const UTF8_DECODER = new TextDecoder("utf-8");

function consumeProcessStream(
  stream: Stream.Stream<Uint8Array, unknown>,
  logBuffer: { value: string },
): Effect.Effect<void, never, never> {
  return pipe(
    stream,
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        logBuffer.value += UTF8_DECODER.decode(chunk);
      }),
    ),
    Effect.catchAll(() => Effect.void),
  );
}

function exitPollToCode(exit: Exit.Exit<number, never>): Option.Option<number> {
  return Exit.match(exit, {
    onSuccess: (code) => Option.some(code),
    onFailure: () => Option.some(-1),
  });
}

function pollExitCode(
  proc: SpawnedProcess,
): Effect.Effect<Option.Option<number>, never, never> {
  return Fiber.poll(proc.exitFiber).pipe(
    Effect.map(
      Option.match({
        onNone: () => Option.none<number>(),
        onSome: exitPollToCode,
      }),
    ),
  );
}

function killAndPoll(
  proc: SpawnedProcess,
  signal: Signal,
  timeoutMs: number,
): Effect.Effect<Option.Option<number>, never, never> {
  return proc.kill(signal).pipe(
    Effect.timeout(`${timeoutMs} millis`),
    Effect.catchAll(() => Effect.void),
    Effect.zipRight(pollExitCode(proc)),
  );
}

function waitAfterSigterm(
  proc: SpawnedProcess,
): Effect.Effect<number, never, never> {
  return killAndPoll(proc, "SIGTERM", OPENCLAW_TERM_WAIT_MS).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          killAndPoll(proc, "SIGKILL", OPENCLAW_KILL_WAIT_MS).pipe(
            Effect.map(Option.getOrElse(() => -1)),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
}

function spawnOpenClawProcess(opts: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logBuffer: { value: string };
}): Effect.Effect<SpawnedProcess, Error, never> {
  const command = pipe(
    Command.make(opts.command, ...opts.args),
    Command.workingDirectory(opts.cwd),
    Command.env(opts.env),
  );

  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const proc = yield* Command.start(command).pipe(Scope.extend(scope));
    const exitFiber = yield* proc.exitCode.pipe(
      Effect.map(Number),
      Effect.catchAll(() => Effect.succeed(-1)),
      Effect.forkIn(scope),
    );
    yield* consumeProcessStream(proc.stdout, opts.logBuffer).pipe(
      Effect.forkIn(scope),
    );
    yield* consumeProcessStream(proc.stderr, opts.logBuffer).pipe(
      Effect.forkIn(scope),
    );
    const kill = (signal: Signal): Effect.Effect<void, never, never> =>
      proc.kill(signal).pipe(Effect.catchAll(() => Effect.void));
    return { proc, exitFiber, kill, scope } satisfies SpawnedProcess;
  }).pipe(
    Effect.provide(NodeContext.layer),
    Effect.mapError((cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
    ),
  );
}

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
  process: SpawnedProcess;
  stateDir: string;
  logBuffer: { value: string };
  spawnInput: SpawnInput;
  tornDown: boolean;
}

interface SpawnedProcess {
  readonly proc: Process;
  readonly exitFiber: Fiber.RuntimeFiber<number, never>;
  readonly kill: (signal: Signal) => Effect.Effect<void, never, never>;
  readonly scope: Scope.CloseableScope;
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
      const port = yield* allocateFreePort();

      const fileSystem = yield* FileSystem.FileSystem;
      const platformPath = yield* Path.Path;
      const { deps } = this;
      const stateDir = yield* fileSystem.makeTempDirectory({
        prefix: `openclaw-${input.agentName}-`,
      });

      yield* writeOpenClawConfig({
        stateDir,
        serverUrl: input.serverUrl,
        apiKey: input.apiKey,
        agentName: input.agentName,
        modelId: input.modelId,
      });
      yield* seedWorkspaceFiles(stateDir, input.workspaceFiles);

      yield* installChannelPlugin(stateDir, deps.channelDistDir, deps.repoRoot);

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

      const logBuffer = { value: "" };
      const child = yield* spawnOpenClawProcess({
        command,
        args,
        cwd: stateDir,
        env: {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: platformPath.join(stateDir, "openclaw.json"),
        },
        logBuffer,
      });

      const st: AdapterState = {
        process: child,
        stateDir,
        logBuffer,
        spawnInput: input,
        tornDown: false,
      };

      this.state = st;
    }).pipe(Effect.mapError(toSpawnFailed), Effect.provide(NodeContext.layer));
  }

  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never> {
    if (!this.state) {
      return Effect.succeed({ _tag: "Ready" as const });
    }
    const { process: proc, spawnInput, logBuffer } = this.state;
    const agentId = spawnInput.agentId;

    const serverReady = this.deps.server.awaitAgentReady(agentId, timeoutMs);

    // Adapter-side `ProcessExited` detector. Polls the Effect process fiber
    // until it exits, then returns the outcome with stderr captured from the
    // live log buffer.
    const exitTick: Effect.Effect<ReadyOutcome | null, never, never> =
      pollExitCode(proc).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (exitCode) => ({
              _tag: "ProcessExited" as const,
              exitCode,
              stderr: logBuffer.value,
            }),
          }),
        ),
      );
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
            : pollExitCode(proc).pipe(
                Effect.map(
                  (exitOpt): ReadyOutcome =>
                    Option.isSome(exitOpt)
                      ? {
                          _tag: "ProcessExited" as const,
                          exitCode: exitOpt.value,
                          stderr: logBuffer.value,
                        }
                      : outcome,
                ),
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
    const full = this.state.logBuffer.value;
    const text = full.slice(offset);
    return { text, nextOffset: full.length };
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
        return { process: state.process, stateDir: state.stateDir };
      });

      if (teardownState === null) return;

      const { process: proc, stateDir } = teardownState;
      const exitOpt = yield* pollExitCode(proc);
      if (Option.isNone(exitOpt)) {
        yield* waitAfterSigterm(proc).pipe(Effect.asVoid);
      }
      yield* Scope.close(proc.scope, Exit.succeed(undefined));

      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          fileSystem.remove(stateDir, { recursive: true, force: true }),
        ),
        Effect.provide(NodeContext.layer),
        Effect.catchAll((cause) =>
          Effect.logWarning(
            "failed to remove OpenClaw adapter state dir",
            cause,
          ),
        ),
      );
    });
  }
}

export function createWorkspaceOpenClawAdapter(
  input: WorkspaceOpenClawAdapterInput,
): OpenClawAdapter {
  const packageRoot = resolveWorkspacePackageRoot();
  const repoRoot =
    input.repoRoot ??
    pathSync((path) => path.dirname(path.dirname(packageRoot)));
  return new OpenClawAdapter({
    server: input.server,
    openclawBin:
      input.openclawBin ??
      resolveWorkspaceOpenClawBin({
        repoRoot,
        workspacePackageRoot: packageRoot,
      }),
    channelDistDir:
      input.channelDistDir ??
      pathSync((path) => path.join(repoRoot, "packages/openclaw-channel/dist")),
    repoRoot,
  });
}

// --- Module-private helpers ---

function resolveWorkspacePackageRoot(): string {
  return pathEffectSync(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const here = yield* path.fromFileUrl(new URL(import.meta.url));
      let current = path.dirname(here);
      while (current !== path.parse(current).root) {
        if (path.basename(current) === "packages") {
          return path.join(current, "runtimes");
        }
        current = path.dirname(current);
      }
      return yield* Effect.fail(
        new WorkspaceRootNotFound({
          message: "Unable to resolve packages/runtimes workspace root",
        }),
      );
    }),
  );
}

function pathSync<A>(f: (path: Path.Path) => A): A {
  return Effect.runSync(
    Path.Path.pipe(Effect.map(f), Effect.provide(Path.layer)),
  );
}

function pathEffectSync<A>(effect: Effect.Effect<A, unknown, Path.Path>): A {
  return Effect.runSync(effect.pipe(Effect.provide(Path.layer), Effect.orDie));
}

function allocateFreePort(): Effect.Effect<
  number,
  PortAllocationFailed | SocketServer.SocketServerError,
  never
> {
  return Effect.scoped(
    NodeSocketServer.make({ host: "127.0.0.1", port: 0 }).pipe(
      Effect.flatMap((server) =>
        server.address._tag === "TcpAddress"
          ? Effect.succeed(server.address.port)
          : Effect.fail(
              new PortAllocationFailed({
                message: "TCP port allocation returned a non-TCP address",
                cause: server.address,
              }),
            ),
      ),
    ),
  ).pipe(Effect.provide(NodeContext.layer));
}

// --- Config and plugin install (module-private) ---

function writeOpenClawConfig(opts: {
  stateDir: string;
  serverUrl: string;
  apiKey: string;
  agentName: string;
  modelId?: string;
}): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> {
  const serverUrl = opts.serverUrl
    .replace(/\/ws$/, "")
    .replace(/^ws:/, "http:");

  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceDir = path.join(opts.stateDir, "workspace");
    const config = {
      agents: {
        defaults: {
          model: { primary: opts.modelId ?? DEFAULT_OPENCLAW_MODEL_ID },
          workspace: workspaceDir,
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
    } satisfies OpenClawConfig;

    yield* Effect.all([
      fileSystem.makeDirectory(workspaceDir, {
        recursive: true,
      }),
      fileSystem.makeDirectory(path.join(opts.stateDir, "logs"), {
        recursive: true,
      }),
      fileSystem.writeFileString(
        path.join(opts.stateDir, "openclaw.json"),
        JSON.stringify(config, null, JSON_INDENT_SPACES),
      ),
    ]);
  });
}

function seedWorkspaceFiles(
  stateDir: string,
  workspaceFiles: SpawnInput["workspaceFiles"],
): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> {
  return seedSharedWorkspaceFiles(stateDir, workspaceFiles);
}

function installChannelPlugin(
  stateDir: string,
  channelDistDir: string,
  repoRoot: string,
): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> {
  // OpenClaw's plugin imports `effect` at load time. Resolve it the way
  // Node would when the channel package itself imported it (#285) — that
  // walks parent `node_modules` directories, so it handles both per-pkg
  // installs (`<pkg>/node_modules/effect`) and workspace hoists
  // (`<repoRoot>/node_modules/effect`). The legacy `dist/node_modules`
  // candidate is kept as a fallback for any consumer that still ships a
  // bundled artifact in that layout.
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const channelPackageDir = path.dirname(channelDistDir);
    const effectResolved = yield* resolveChannelDependency(
      channelPackageDir,
      "effect",
    );
    yield* installSharedChannelPlugin({
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
  });
}
