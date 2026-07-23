/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { createRequire } from "node:module";
import { Command, FileSystem, Path, SocketServer } from "@effect/platform";
import type { Process, Signal } from "@effect/platform/CommandExecutor";
import { Data, Effect, Exit, Fiber, Option, Scope, Stream, pipe } from "effect";
import { NodeContext, NodeSocketServer } from "@effect/platform-node";
import type { MoltzapChannelPlugin } from "@moltzap/openclaw-channel";
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
  processExitLoop,
  promoteTimeoutIfProcessExited,
} from "./adapter-readiness.js";
import {
  installChannelPlugin,
  seedWorkspaceFiles,
  TESTBED_PROFILE_NAME,
  writeMoltZapProfileConfig,
} from "./channel-plugin-install.js";
import {
  resolveInstalledPackageBin,
  resolveInstalledPackageRoot,
} from "./package-resolution.js";

const OPENCLAW_TERM_WAIT_MS = 10_000;
const OPENCLAW_KILL_WAIT_MS = 5_000;
const DEFAULT_OPENCLAW_MODEL_ID = "openai-codex/gpt-5.4";
const OPENCLAW_CHANNEL_ID = "moltzap" satisfies MoltzapChannelPlugin["id"];
const TOKEN_RADIX = 36;
const JSON_INDENT_SPACES = 2;
const OPENCLAW_CHANNEL_LOOKUP_PATHS =
  createRequire(import.meta.url).resolve.paths("@moltzap/openclaw-channel") ??
  [];

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

function stopSpawnedOpenClawProcess(
  proc: SpawnedProcess,
): Effect.Effect<void, never, never> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const exitOpt = yield* pollExitCode(proc);
      if (Option.isNone(exitOpt)) {
        yield* waitAfterSigterm(proc).pipe(Effect.asVoid);
      }
      yield* Scope.close(proc.scope, Exit.succeed(undefined));
    }),
  );
}

function initializeOpenClawProcess(
  command: Command.Command,
  logBuffer: { value: string },
  scope: Scope.CloseableScope,
) {
  return Effect.gen(function* () {
    const proc = yield* Command.start(command).pipe(Scope.extend(scope));
    const exitFiber = yield* proc.exitCode.pipe(
      Effect.map(Number),
      Effect.catchAll(() => Effect.succeed(-1)),
      Effect.forkIn(scope),
    );
    yield* consumeProcessStream(proc.stdout, logBuffer).pipe(
      Effect.forkIn(scope),
    );
    yield* consumeProcessStream(proc.stderr, logBuffer).pipe(
      Effect.forkIn(scope),
    );
    const kill = (signal: Signal): Effect.Effect<void, never, never> =>
      proc.kill(signal).pipe(Effect.catchAll(() => Effect.void));
    return { proc, exitFiber, kill, scope } satisfies SpawnedProcess;
  });
}

function closeScopeOnFailedProcessStart(
  scope: Scope.CloseableScope,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void, never, never> {
  return Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit);
}

function captureSpawnedOpenClawProcess(
  lease: OpenClawSpawnLease,
  process: SpawnedProcess,
): Effect.Effect<void, never, never> {
  return Effect.sync(() => {
    lease.process = process;
  });
}

function releaseOpenClawSpawnLease(
  lease: OpenClawSpawnLease,
): Effect.Effect<void, never, never> {
  return lease.committed || lease.process === null
    ? Effect.void
    : stopSpawnedOpenClawProcess(lease.process);
}

function spawnOpenClawProcess(opts: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logBuffer: { value: string };
  readonly onStarted: (
    process: SpawnedProcess,
  ) => Effect.Effect<void, never, never>;
}): Effect.Effect<SpawnedProcess, Error, never> {
  const command = pipe(
    Command.make(opts.command, ...opts.args),
    Command.workingDirectory(opts.cwd),
    Command.env(opts.env),
  );

  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      return yield* Effect.gen(function* () {
        const started = yield* restore(
          initializeOpenClawProcess(command, opts.logBuffer, scope),
        );
        yield* opts.onStarted(started);
        return started;
      }).pipe(
        Effect.onExit((exit) => closeScopeOnFailedProcessStart(scope, exit)),
      );
    }),
  ).pipe(
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
}

export interface OpenClawAdapterOptions {
  readonly server: RuntimeServerHandle;
  readonly openclawBin?: string;
  readonly channelDistDir?: string;
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

interface OpenClawSpawnLease {
  process: SpawnedProcess | null;
  committed: boolean;
}

interface OpenClawProcessPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

function buildOpenClawProcessPlan(
  openclawBin: string,
  port: number,
): OpenClawProcessPlan {
  const openclawArgs = [
    "gateway",
    "run",
    "--allow-unconfigured",
    "--port",
    String(port),
  ];
  return openclawBin.endsWith(".mjs")
    ? { command: "node", args: [openclawBin, ...openclawArgs] }
    : { command: openclawBin, args: openclawArgs };
}

function allocateOpenClawStateDir(
  input: SpawnInput,
): Effect.Effect<string, unknown, FileSystem.FileSystem> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.makeTempDirectory({
        prefix: `openclaw-${input.agentName}-`,
      }),
    ),
  );
}

function configureOpenClawStateDir(
  deps: OpenClawAdapterDeps,
  input: SpawnInput,
  stateDir: string,
): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> {
  return Effect.all(
    [
      writeOpenClawConfig({
        stateDir,
        agentName: input.agentName,
        agentId: input.agentId,
        apiKey: input.apiKey,
        modelId: input.modelId,
      }),
      seedWorkspaceFiles(stateDir, input.workspaceFiles),
    ],
    { discard: true },
  ).pipe(
    Effect.zipRight(
      installChannelPlugin({
        stateDir,
        channelDistDir: deps.channelDistDir,
        extName: "openclaw-channel",
        // OpenClaw discovers channel plugins through this package-root manifest.
        extraPackageFiles: ["openclaw.plugin.json"],
      }).pipe(Effect.asVoid),
    ),
  );
}

function removeOpenClawStateDir(
  stateDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.remove(stateDir, { recursive: true, force: true }),
    ),
    Effect.catchAll((cause) =>
      Effect.logWarning("failed to remove OpenClaw adapter state dir", cause),
    ),
  );
}

function spawnConfiguredOpenClaw(options: {
  readonly deps: OpenClawAdapterDeps;
  readonly stateDir: string;
  readonly input: SpawnInput;
  readonly port: number;
  readonly logBuffer: { value: string };
  readonly onStarted: (
    process: SpawnedProcess,
  ) => Effect.Effect<void, never, never>;
}): Effect.Effect<SpawnedProcess, Error, Path.Path> {
  return Path.Path.pipe(
    Effect.flatMap((platformPath) => {
      const plan = buildOpenClawProcessPlan(
        options.deps.openclawBin,
        options.port,
      );
      return spawnOpenClawProcess({
        ...plan,
        cwd: options.stateDir,
        env: {
          OPENCLAW_STATE_DIR: options.stateDir,
          OPENCLAW_CONFIG_PATH: platformPath.join(
            options.stateDir,
            "openclaw.json",
          ),
          MOLTZAP_CONFIG_HOME: platformPath.join(options.stateDir, ".moltzap"),
          MOLTZAP_SERVER_URL: options.input.serverUrl,
        },
        logBuffer: options.logBuffer,
        onStarted: options.onStarted,
      });
    }),
  );
}

function startOpenClawAdapter(
  deps: OpenClawAdapterDeps,
  input: SpawnInput,
  commit: (state: AdapterState) => void,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.scoped(
      Effect.gen(function* () {
        const port = yield* restore(allocateFreePort());
        const lease: OpenClawSpawnLease = {
          process: null,
          committed: false,
        };
        const stateDir = yield* Effect.acquireRelease(
          allocateOpenClawStateDir(input),
          (leasedStateDir) =>
            lease.committed
              ? Effect.void
              : removeOpenClawStateDir(leasedStateDir),
        );
        yield* restore(configureOpenClawStateDir(deps, input, stateDir));
        const logBuffer = { value: "" };
        const child = yield* restore(
          Effect.acquireReleaseInterruptible(
            spawnConfiguredOpenClaw({
              deps,
              stateDir,
              input,
              port,
              logBuffer,
              onStarted: (started) =>
                captureSpawnedOpenClawProcess(lease, started),
            }),
            () => releaseOpenClawSpawnLease(lease),
          ),
        );

        commit({
          process: child,
          stateDir,
          logBuffer,
          spawnInput: input,
          tornDown: false,
        });
        lease.committed = true;
      }),
    ),
  );
}

/**
 * OpenClaw runtime adapter. Spawns the OpenClaw gateway as a child
 * process, configures it with a moltzap channel plugin, and reports
 * readiness via the server-side WS authentication event.
 *
 * ```mermaid
 * flowchart TD
 *   OCS["OpenClawAdapter.spawn(input)"]
 *   OC1["1. allocateFreePort()<br>NodeSocketServer.make({ port: 0 })"]
 *   OC2["2. lease + configure state dir<br>makeTempDirectory, writeOpenClawConfig,<br>seedWorkspaceFiles, installChannelPlugin"]
 *   OC3["3. buildOpenClawProcessPlan(openclawBin, port)<br>(handles .mjs vs binary entry)"]
 *   OC4["4. lease spawnOpenClawProcess(env=OPENCLAW_STATE_DIR,<br>OPENCLAW_CONFIG_PATH)<br>exitFiber + log buffer"]
 *   OC5["5. commit process + state-dir leases<br>to adapter state"]
 *   OCF["failed or interrupted handoff<br>stops child + removes state dir"]
 *   OCR["waitUntilReady<br>race(server.awaitAgentReady, processExitLoop)<br>inbound marker: 'inbound from agent:'"]
 *   OCS --> OC1 --> OC2 --> OC3 --> OC4 --> OC5 --> OCR
 *   OC2 -.->|failure| OCF
 *   OC4 -.->|failure or interruption| OCF
 * ```
 *
 * Readiness signal: server-side WS authentication event surfaces via
 * `deps.server.awaitAgentReady`. Inbound traffic log marker:
 * `inbound from agent:`. Errors flow into the testbed via `SpawnFailed`
 * (boot) or `RuntimeExitedBeforeReady` / `RuntimeReadyTimedOut`
 * (post-spawn, surfaced by `processExitLoop`).
 */
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

    return startOpenClawAdapter(this.deps, input, (state) => {
      this.state = state;
    }).pipe(Effect.mapError(toSpawnFailed), Effect.provide(NodeContext.layer));
  }

  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never> {
    if (!this.state) {
      return Effect.succeed({ _tag: "Ready" as const });
    }
    const { process: proc, spawnInput, logBuffer } = this.state;
    const agentId = spawnInput.agentId;

    const serverReady = this.deps.server.awaitAgentReady(agentId, timeoutMs);
    const processExit = {
      pollExitCode: () => pollExitCode(proc),
      stderr: () => logBuffer.value,
      timeoutMs,
    };

    return pipe(
      Effect.race(serverReady, processExitLoop(processExit)),
      // Final-check: if the race resolved `Timeout`, the child may have
      // exited within the last `exitLoop` tick window — one last sync probe
      // promotes that case to `ProcessExited` with the actual exit code so
      // the diagnostic stderr isn't lost behind an opaque `Timeout`.
      Effect.flatMap((outcome) =>
        promoteTimeoutIfProcessExited(outcome, processExit),
      ),
      // Failure outcomes (Timeout, ProcessExited) tear down before returning.
      Effect.tap((outcome) =>
        outcome._tag === "Ready" ? Effect.void : this.teardown(),
      ),
    );
  }

  teardown(): Effect.Effect<void, never, never> {
    return Effect.uninterruptible(
      Effect.gen(this, function* () {
        const teardownState = yield* Effect.sync(() => {
          const state = this.state;
          if (!state || state.tornDown) return null;
          state.tornDown = true;
          return { process: state.process, stateDir: state.stateDir };
        });

        if (teardownState === null) return;

        const { process: proc, stateDir } = teardownState;
        yield* stopSpawnedOpenClawProcess(proc);
        yield* removeOpenClawStateDir(stateDir).pipe(
          Effect.provide(NodeContext.layer),
        );
      }),
    );
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
}

/**
 * Creates an {@link OpenClawAdapter}. Omitted paths resolve from this package's
 * installed, versioned `openclaw` and `@moltzap/openclaw-channel`
 * dependencies. Callers may override either path for local development.
 *
 * ```mermaid
 * flowchart TD
 *   OCWF["createOpenClawAdapter(input)"]
 *   OCBIN["openclawBin = input.openclawBin ??<br>resolveInstalledPackageBin('openclaw')"]
 *   OCCH["channelDistDir = input.channelDistDir ??<br>resolveInstalledPackageRoot('@moltzap/openclaw-channel')/dist"]
 *   OCOUT["new OpenClawAdapter({ server, openclawBin, channelDistDir })"]
 *   OCWF --> OCBIN --> OCCH --> OCOUT
 * ```
 */
export function createOpenClawAdapter(
  input: OpenClawAdapterOptions,
): OpenClawAdapter {
  return new OpenClawAdapter({
    server: input.server,
    openclawBin:
      input.openclawBin ?? resolveInstalledPackageBin("openclaw", "openclaw"),
    channelDistDir: input.channelDistDir ?? resolveOpenClawChannelDistDir(),
  });
}

// --- Module-private helpers ---

function resolveOpenClawChannelDistDir(): string {
  return pathSync((path) =>
    path.join(
      resolveInstalledPackageRoot(
        "@moltzap/openclaw-channel",
        OPENCLAW_CHANNEL_LOOKUP_PATHS,
      ),
      "dist",
    ),
  );
}

function pathSync<A>(f: (path: Path.Path) => A): A {
  return Effect.runSync(
    Path.Path.pipe(Effect.map(f), Effect.provide(Path.layer)),
  );
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
  agentName: string;
  agentId: SpawnInput["agentId"];
  apiKey: SpawnInput["apiKey"];
  modelId?: string;
}): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceDir = path.join(opts.stateDir, "workspace");
    const config = buildOpenClawConfig(opts, workspaceDir);

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
      writeMoltZapProfileConfig(path.join(opts.stateDir, ".moltzap"), opts),
    ]);
  });
}

function buildOpenClawConfig(
  opts: {
    readonly agentName: string;
    readonly modelId?: string;
  },
  workspaceDir: string,
): OpenClawConfig {
  return {
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
      [OPENCLAW_CHANNEL_ID]: {
        accounts: [
          {
            id: TESTBED_PROFILE_NAME,
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
}
