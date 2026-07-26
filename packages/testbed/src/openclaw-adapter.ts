/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { homedir } from "node:os";
import { join } from "node:path";
import { Command, FileSystem, Path, SocketServer } from "@effect/platform";
import type { Process } from "@effect/platform/CommandExecutor";
import { Config, Data, Effect, Exit, Fiber, Option, Scope } from "effect";
import { NodeContext, NodeSocketServer } from "@effect/platform-node";
import type { MoltzapChannelPlugin } from "@moltzap/openclaw-channel";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import type {
  Runtime,
  RuntimeServerHandle,
  ServerUrl,
  SpawnInput,
  LogSlice,
  ReadyOutcome,
} from "./runtime.js";
import { SpawnFailed, spawnFailed } from "./errors.js";
import { raceReadiness } from "./adapter-readiness.js";
import {
  type BaseChildEnvironment,
  BaseChildEnvironmentConfig,
  BoundedLogBuffer,
  escalatingKill,
  makeExactEnvironmentCommand,
  pollFiberExitCode,
  type ProcessTreeCleanup,
  startSupervisedProcess,
} from "./child-process.js";
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
const DEFAULT_OPENCLAW_MODEL_ID = "openai/gpt-5.5";
const OPENCLAW_CHANNEL_ID = "moltzap" satisfies MoltzapChannelPlugin["id"];
const OPENCLAW_EXTENSION_NAME = "openclaw-channel";
const TOKEN_RADIX = 36;
const JSON_INDENT_SPACES = 2;

class PortAllocationFailed extends Data.TaggedError("PortAllocationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function pollExitCode(
  proc: SpawnedProcess,
): Effect.Effect<Option.Option<number>, never, never> {
  return pollFiberExitCode(proc.exitFiber);
}

function stopSpawnedOpenClawProcess(
  proc: SpawnedProcess,
): Effect.Effect<void, never, never> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      yield* escalatingKill(
        proc.proc,
        proc.exitFiber,
        {
          termWaitMs: OPENCLAW_TERM_WAIT_MS,
          killWaitMs: OPENCLAW_KILL_WAIT_MS,
        },
        proc.processTreeCleanup,
      );
      yield* Scope.close(proc.scope, Exit.succeed(undefined));
    }),
  );
}

function initializeOpenClawProcess(
  command: Command.Command,
  logBuffer: BoundedLogBuffer,
  scope: Scope.CloseableScope,
) {
  return startSupervisedProcess(
    command,
    scope,
    (chunk) => {
      logBuffer.append(chunk);
    },
    {
      claimed: false,
      launcherOwnsExitCleanup: true,
    },
  ).pipe(
    Effect.map(
      ({ proc, exitFiber, processTreeCleanup }) =>
        ({
          proc,
          exitFiber,
          processTreeCleanup,
          scope,
        }) satisfies SpawnedProcess,
    ),
  );
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
  readonly logBuffer: BoundedLogBuffer;
  readonly onStarted: (
    process: SpawnedProcess,
  ) => Effect.Effect<void, never, never>;
}): Effect.Effect<SpawnedProcess, Error, never> {
  const command = makeExactEnvironmentCommand({
    ...opts,
    cleanupTreeOnExit: true,
  });

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

/** One stdio MCP server wired into the runtime at spawn time (the simulator's mount plan shape). */
export interface McpServerMount {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export interface OpenClawAdapterDeps {
  readonly server: RuntimeServerHandle;
  readonly openclawBin: string;
  readonly channelDistDir: string;
  readonly mcpServers?: ReadonlyArray<McpServerMount>;
}

export interface OpenClawAdapterOptions {
  readonly server: RuntimeServerHandle;
  readonly openclawBin?: string;
  readonly channelDistDir?: string;
  readonly mcpServers?: ReadonlyArray<McpServerMount>;
}

interface AdapterState {
  process: SpawnedProcess;
  stateDir: string;
  logBuffer: BoundedLogBuffer;
  spawnInput: SpawnInput;
  tornDown: boolean;
}

interface SpawnedProcess {
  readonly proc: Process;
  readonly exitFiber: Fiber.RuntimeFiber<number, never>;
  readonly processTreeCleanup?: ProcessTreeCleanup;
  readonly scope: Scope.CloseableScope;
}

interface OpenClawSpawnLease {
  process: SpawnedProcess | null;
  committed: boolean;
}

interface OpenClawProcessPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

// A `ServerUrl` carries the server's `/ws` endpoint path, while the moltzap
// client appends `/ws` to whatever base it reads from the environment, so a
// child handed the path verbatim dials `/ws/ws` and its upgrade answers 404.
function normalizeOpenClawServerUrl(serverUrl: ServerUrl): string {
  return serverUrl
    .replace(/\/ws$/, "")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:");
}

/** @internal */
export function buildOpenClawProcessPlan(opts: {
  readonly openclawBin: string;
  readonly port: number;
  readonly stateDir: string;
  readonly input: SpawnInput;
  readonly baseEnvironment: BaseChildEnvironment;
}): OpenClawProcessPlan {
  const openclawArgs = [
    "gateway",
    "run",
    "--allow-unconfigured",
    "--port",
    String(opts.port),
  ];
  const entrypoint = opts.openclawBin.endsWith(".mjs")
    ? { command: "node", args: [opts.openclawBin, ...openclawArgs] }
    : { command: opts.openclawBin, args: openclawArgs };
  return {
    ...entrypoint,
    cwd: opts.stateDir,
    env: {
      ...opts.baseEnvironment,
      OPENCLAW_STATE_DIR: opts.stateDir,
      OPENCLAW_CONFIG_PATH: join(opts.stateDir, "openclaw.json"),
      MOLTZAP_CONFIG_HOME: join(opts.stateDir, ".moltzap"),
      MOLTZAP_SERVER_URL: normalizeOpenClawServerUrl(opts.input.serverUrl),
    },
  };
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

// Model-provider auth lives in the per-state-dir agent store, and login is
// an interactive flow — spawned agents get fresh temp state dirs, so the
// operator logs in once against the default ~/.openclaw state and every
// agent seeds its store from there. The sqlite WAL companions are copied
// with the store so a not-yet-checkpointed login survives the copy.
const OPERATOR_AUTH_STORE_FILES = [
  "auth-profiles.json",
  "openclaw-agent.sqlite",
  "openclaw-agent.sqlite-shm",
  "openclaw-agent.sqlite-wal",
];

// "main" is openclaw's default agent id; per-agent auth resolution beyond
// the OPENCLAW_HOME override stays with the granularity follow-up.
const OPERATOR_AGENT_REL_DIR = join("agents", "main", "agent");

const OperatorOpenClawHome = Config.string("OPENCLAW_HOME").pipe(
  Config.withDefault(""),
  Config.map((value) => value.trim() || join(homedir(), ".openclaw")),
);

function seedModelAuthProfile(
  stateDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const operatorHome = yield* OperatorOpenClawHome;
    const operatorAgentDir = join(operatorHome, OPERATOR_AGENT_REL_DIR);
    const present = yield* Effect.all(
      OPERATOR_AUTH_STORE_FILES.map((fileName) =>
        fileSystem
          .exists(join(operatorAgentDir, fileName))
          .pipe(Effect.map((exists) => (exists ? fileName : null))),
      ),
      { concurrency: OPERATOR_AUTH_STORE_FILES.length },
    );
    const fileNames = present.filter(
      (fileName): fileName is string => fileName !== null,
    );
    if (fileNames.length === 0) return;
    const destinationDir = join(stateDir, OPERATOR_AGENT_REL_DIR);
    yield* fileSystem.makeDirectory(destinationDir, { recursive: true });
    yield* Effect.all(
      fileNames.map((fileName) =>
        fileSystem.copyFile(
          join(operatorAgentDir, fileName),
          join(destinationDir, fileName),
        ),
      ),
      { concurrency: fileNames.length, discard: true },
    );
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.logWarning("failed to seed openclaw model auth store", cause),
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
        mcpServers: deps.mcpServers,
      }),
      seedWorkspaceFiles(join(stateDir, "workspace"), input.workspaceFiles),
      seedModelAuthProfile(stateDir),
    ],
    { concurrency: 3, discard: true },
  ).pipe(
    Effect.zipRight(
      installChannelPlugin({
        stateDir,
        channelDistDir: deps.channelDistDir,
        extName: OPENCLAW_EXTENSION_NAME,
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
  readonly logBuffer: BoundedLogBuffer;
  readonly onStarted: (
    process: SpawnedProcess,
  ) => Effect.Effect<void, never, never>;
}): Effect.Effect<SpawnedProcess, Error, never> {
  return Effect.gen(function* () {
    const baseEnvironment = yield* BaseChildEnvironmentConfig;
    return yield* spawnOpenClawProcess({
      ...buildOpenClawProcessPlan({
        openclawBin: options.deps.openclawBin,
        port: options.port,
        stateDir: options.stateDir,
        input: options.input,
        baseEnvironment,
      }),
      logBuffer: options.logBuffer,
      onStarted: options.onStarted,
    });
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
    ),
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
        const logBuffer = new BoundedLogBuffer();
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
 *   OC3["3. buildOpenClawProcessPlan<br>entry (.mjs vs binary), cwd,<br>exact child environment"]
 *   OC4["4. lease spawnOpenClawProcess<br>exitFiber + log buffer"]
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
    return startOpenClawAdapter(this.deps, input, (state) => {
      this.state = state;
    }).pipe(
      Effect.mapError((cause) => spawnFailed(input.agentName, cause)),
      Effect.provide(NodeContext.layer),
    );
  }

  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never> {
    if (!this.state) {
      return Effect.succeed({ _tag: "Ready" as const });
    }
    const { process: proc, spawnInput, logBuffer } = this.state;
    return raceReadiness({
      serverReady: this.deps.server.awaitAgentReady(
        spawnInput.agentId,
        timeoutMs,
      ),
      source: {
        pollExitCode: () => pollExitCode(proc),
        stderr: () => logBuffer.text,
        timeoutMs,
      },
      teardown: () => this.teardown(),
    });
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
    return this.state.logBuffer.read(offset);
  }

  getInboundMarker(): string {
    return "inbound from agent:";
  }

  /** Resolves once, on the gateway process's exit (the simulator's ongoing exit signal). */
  awaitExit(): Effect.Effect<
    { readonly exitCode: number | null; readonly signal: string | undefined },
    never,
    never
  > {
    const state = this.state;
    if (!state) {
      return Effect.succeed({ exitCode: null, signal: undefined });
    }
    return Fiber.join(state.process.exitFiber).pipe(
      Effect.map((exitCode) =>
        exitCode >= 0
          ? { exitCode, signal: undefined }
          : { exitCode: null, signal: undefined },
      ),
    );
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
  return join(
    resolveInstalledPackageRoot("@moltzap/openclaw-channel", import.meta.url),
    "dist",
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
  mcpServers?: ReadonlyArray<McpServerMount>;
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

/** @internal */
function mcpConfigSection(
  mcpServers: ReadonlyArray<McpServerMount> | undefined,
): Pick<OpenClawConfig, "mcp"> {
  if (mcpServers === undefined || mcpServers.length === 0) return {};
  return {
    mcp: {
      servers: Object.fromEntries(
        mcpServers.map((server) => [
          server.name,
          {
            transport: "stdio" as const,
            command: server.command,
            args: [...server.args],
            env: { ...server.env },
          },
        ]),
      ),
    },
  };
}

export function buildOpenClawConfig(
  opts: {
    readonly agentName: string;
    readonly modelId?: string;
    readonly mcpServers?: ReadonlyArray<McpServerMount>;
  },
  workspaceDir: string,
): OpenClawConfig {
  return {
    ...mcpConfigSection(opts.mcpServers),
    agents: {
      defaults: {
        model: { primary: opts.modelId ?? DEFAULT_OPENCLAW_MODEL_ID },
        workspace: workspaceDir,
        compaction: { mode: "safeguard" },
        // Left unset, openclaw seeds BOOTSTRAP.md into the empty per-agent
        // workspace and runs its first-run onboarding ritual, whose scripted
        // opening line the agent sends in place of answering the step.
        skipBootstrap: true,
      },
    },
    commands: { native: "auto", nativeSkills: "auto", restart: true },
    // The channel extension is copied into the state dir without install
    // provenance; openclaw treats such plugins as untracked local code and
    // will not start their channels unless trust is pinned explicitly.
    plugins: { allow: [OPENCLAW_EXTENSION_NAME] },
    messages: {
      // openclaw's own default and the closest heir to the removed passive
      // "queue" mode: mid-turn messages steer the active turn instead of
      // buffering (matching the nanoclaw runtime's push behavior).
      queue: { mode: "steer", debounceMs: 0, cap: 100, drop: "new" },
    },
    // Fleet agents use direct MoltZap channel addressing, so LAN discovery
    // only creates contention between colocated gateways.
    discovery: { mdns: { mode: "off" } },
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
