/* eslint-disable jsdoc/text-escaping -- Mermaid blocks need literal `<br>` (HTML5) for renderer compatibility. */
/** @file OpenClaw process configuration, resource acquisition, and supervision. */
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  type Command,
  type CommandExecutor,
  type Error as PlatformError,
  FileSystem,
  Path,
  type SocketServer,
} from "@effect/platform";
import {
  Cause,
  Config,
  Data,
  Effect,
  Exit,
  Fiber,
  Inspectable,
  Redacted,
  Scope,
} from "effect";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import type { MoltzapChannelPlugin } from "@moltzap/openclaw-channel";
import type { AgentId, AgentKey, AgentName } from "@moltzap/protocol/identity";
import { httpBaseUrl, type ServerBaseUrl } from "@moltzap/protocol/network";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type {
  AgentDefaultsConfig,
  ToolsConfig,
} from "openclaw/plugin-sdk/config-types";

import {
  type BaseChildEnvironment,
  baseChildEnvironmentConfig,
  BoundedLogBuffer,
  escalatingKill,
  makeExactEnvironmentCommand,
  type ProcessTreeCleanup,
  startSupervisedProcess,
} from "../command.js";
import {
  installChannelPlugin,
  seedWorkspaceFiles,
  SIMULATOR_PROFILE_NAME,
  writeMoltZapProfileConfig,
} from "../workspace.js";
import {
  type InstallMode,
  resolveInstalledPackageBin,
  resolveInstalledPackageRoot,
} from "../packages.js";
import { materializePublishedOpenClawPlugin } from "./cache.js";

const OPENCLAW_TERM_WAIT_MS = 10_000;
const OPENCLAW_KILL_WAIT_MS = 5_000;
const DEFAULT_OPENCLAW_MODEL_ID = "openai/gpt-5.5";
const OPENCLAW_CHANNEL_ID = "moltzap" satisfies MoltzapChannelPlugin["id"];
const OPENCLAW_EXTENSION_NAME = "openclaw-channel";
const OPENCLAW_GATEWAY_TOKEN_BYTES = 32;
const OPENCLAW_GATEWAY_TOKEN_REDACTION_MARKER =
  "[REDACTED:openclaw-gateway-token]";
const JSON_INDENT_SPACES = 2;
const OPENCLAW_WORKSPACE_DIRNAME = "workspace";
const OPENCLAW_ATTESTATION_DIRNAME = "workspace-attestations";
const OPENCLAW_ATTESTATION_SUFFIX = ".attested";
const EPHEMERAL_PORT = 0;

/** Ports assigned to OpenClaw children that still own their process scope. */
const CLAIMED_OPENCLAW_PORTS = new Set<number>();

class PortAllocationFailed extends Data.TaggedError("PortAllocationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class OpenClawInstallModeError extends Data.TaggedError(
  "OpenClawInstallModeError",
)<{
  readonly message: string;
  readonly channelDistDir: string;
  readonly resolvedChannelDistDir: string;
}> {}

function stopSpawnedOpenClawProcess(proc: SpawnedProcess): Effect.Effect<void> {
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
): Effect.Effect<void> {
  return Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit);
}

function captureSpawnedOpenClawProcess(
  lease: OpenClawSpawnLease,
  process: SpawnedProcess,
): Effect.Effect<void> {
  return Effect.sync(() => {
    lease.process = process;
  });
}

function releaseOpenClawSpawnLease(
  lease: OpenClawSpawnLease,
): Effect.Effect<void> {
  return lease.committed || lease.process === null
    ? Effect.void
    : stopSpawnedOpenClawProcess(lease.process);
}

function releasePortClaimWhenProcessEnds(
  process: SpawnedProcess,
  portClaim: OpenClawPortClaim,
): Effect.Effect<void> {
  return Fiber.join(process.exitFiber).pipe(
    Effect.asVoid,
    Effect.ensuring(portClaim.release()),
    Effect.forkIn(process.scope),
    Effect.asVoid,
  );
}

function spawnOpenClawProcess(opts: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logBuffer: BoundedLogBuffer;
  readonly onStarted: (process: SpawnedProcess) => Effect.Effect<void>;
}): Effect.Effect<SpawnedProcess, Error, CommandExecutor.CommandExecutor> {
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
    Effect.mapError((cause) =>
      cause instanceof Error ? cause : new Cause.UnknownException(cause),
    ),
  );
}

/** One stdio MCP server wired into an OpenClaw process at spawn time. */
interface McpServerMount {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Native OpenClaw tool exposure and execution configuration. */
export type OpenClawToolsConfig = ToolsConfig;

/** Native OpenClaw sandbox configuration for the runtime's default agent. */
export type OpenClawSandboxConfig = NonNullable<AgentDefaultsConfig["sandbox"]>;

/**
 * Immutable host configuration for one OpenClaw process.
 * @internal
 */
export interface OpenClawProcessOptions {
  readonly openclawBin: string;
  readonly channelDistDir: string;
  readonly installMode: InstallMode;
  readonly mcpServers?: readonly McpServerMount[];
}

/**
 * Optional package locations accepted before host configuration is resolved.
 * @internal
 */
export interface OpenClawProcessOptionOverrides {
  readonly openclawBin?: string;
  readonly channelDistDir?: string;
  readonly installMode: InstallMode;
  readonly mcpServers?: readonly McpServerMount[];
}

/**
 * Router attachment material consumed by the OpenClaw child process.
 * @internal
 */
export interface OpenClawProcessInput {
  readonly agentName: AgentName;
  readonly apiKey: AgentKey;
  readonly agentId: AgentId;
  readonly serverUrl: ServerBaseUrl;
  /** Omit only when a runtime must not inherit the operator's model auth. */
  readonly seedOperatorAuth?: boolean;
  readonly workspaceFiles?: ReadonlyArray<{
    readonly relativePath: string;
    readonly content: string;
  }>;
  readonly modelId?: string;
  readonly tools?: OpenClawToolsConfig;
  readonly sandbox?: OpenClawSandboxConfig;
}

/**
 * Scope-owned observations for one OpenClaw process.
 * @internal
 */
export interface OpenClawProcessSession {
  readonly exitCode: Effect.Effect<
    CommandExecutor.ExitCode,
    PlatformError.PlatformError
  >;
  readonly output: () => string;
  readonly gatewayUrl: `ws://127.0.0.1:${number}`;
  readonly gatewayToken: Redacted.Redacted;
  readonly agentName: AgentName;
}

interface SpawnedProcess {
  readonly proc: CommandExecutor.Process;
  readonly exitFiber: Fiber.RuntimeFiber<
    CommandExecutor.ExitCode,
    PlatformError.PlatformError
  >;
  readonly processTreeCleanup?: ProcessTreeCleanup;
  readonly scope: Scope.CloseableScope;
}

interface OpenClawSpawnLease {
  process: SpawnedProcess | null;
  committed: boolean;
}

interface BoundOpenClawPort {
  readonly port: number;
}

interface OpenClawPortClaim {
  readonly port: number;
  transfer(): Effect.Effect<void>;
  release(): Effect.Effect<void>;
}

/**
 * Explicitly owned resources for one running OpenClaw gateway.
 * @internal
 */
interface OpenClawRuntimeHandle {
  readonly process: SpawnedProcess;
  readonly stateDir: string;
  readonly logBuffer: BoundedLogBuffer;
  readonly portClaim: OpenClawPortClaim;
  readonly gatewayToken: Redacted.Redacted;
  readonly agentName: AgentName;
}

type LeasedOpenClawPortClaim = OpenClawPortClaim & {
  closeStartupLease(): Effect.Effect<void>;
};

interface OpenClawPortClaimState {
  transferred: boolean;
  released: boolean;
}

interface OpenClawPortLeaseOptions {
  /**
   * Candidate request used by deterministic allocation tests. Production
   * requests port zero so the kernel chooses each candidate.
   */
  readonly candidatePort?: () => number;
}

interface OpenClawProcessPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Build the exact OpenClaw child-process command and environment.
 *
 * @param opts Value supplied to the operation.
 * @param opts.openclawBin Value supplied to the operation.
 * @param opts.port Value supplied to the operation.
 * @param opts.stateDir Value supplied to the operation.
 * @param opts.input Value supplied to the operation.
 * @param opts.baseEnvironment Value supplied to the operation.
 * @internal
 * @returns The created open claw process plan.
 */
export function buildOpenClawProcessPlan(opts: {
  readonly openclawBin: string;
  readonly port: number;
  readonly stateDir: string;
  readonly input: OpenClawProcessInput;
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
      HOME: opts.stateDir,
      OPENCLAW_STATE_DIR: opts.stateDir,
      OPENCLAW_CONFIG_PATH: join(opts.stateDir, "openclaw.json"),
      MOLTZAP_CONFIG_HOME: join(opts.stateDir, ".moltzap"),
      MOLTZAP_SERVER_URL: httpBaseUrl(opts.input.serverUrl),
    },
  };
}

function allocateOpenClawStateDir(
  input: OpenClawProcessInput,
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

const operatorOpenClawHome = Config.string("OPENCLAW_HOME").pipe(
  Config.withDefault(""),
  Config.map((value) => value.trim() || join(homedir(), ".openclaw")),
);

function seedModelAuthProfile(
  stateDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const operatorHome = yield* operatorOpenClawHome;
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
    if (fileNames.length === 0) {
      return;
    }
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

function openClawWorkspaceDir(stateDir: string): string {
  return join(stateDir, OPENCLAW_WORKSPACE_DIRNAME);
}

/**
 * Occupies the attestation paths OpenClaw derives for this run's workspace
 * with directories. `lstat` succeeds and `isFile()` is false, so OpenClaw
 * reads the workspace as never attested and writes no marker of its own.
 *
 * OpenClaw's guard refuses to reseed a workspace that was attested recently
 * and is now empty, which protects a durable operator workspace from silent
 * reseeding. A simulated agent's workspace is per-run, empty unless the
 * runtime policy declares files, and the agent may delete anything in it: one
 * create-then-delete otherwise leaves the guard throwing for the rest of the
 * run, uncaught, and the ledger records that as agent silence.
 *
 * OpenClaw consults a third candidate under its legacy home state dir. That
 * path is the operator's rather than the run's, so it is left alone. Of the
 * two occupied here only the first is one OpenClaw ever writes; the sibling
 * marker it reads but never writes is held defensively.
 *
 * The derivation is OpenClaw's own, recomputed because no public entry
 * exports it, and it fails unsafely: a sentinel at the wrong path leaves
 * OpenClaw free to write a real attestation at the right one. Only directories
 * work. Blocking a path instead, by permissions or by an `ENOTDIR` parent,
 * makes OpenClaw trust what it cannot read as attested and arms the guard on
 * the first turn.
 * @param stateDir Value supplied to the operation.
 * @returns The disarm open claw attestation guard result.
 */
function disarmOpenClawAttestationGuard(
  stateDir: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  const resolvedWorkspaceDir = resolve(openClawWorkspaceDir(stateDir));
  const key = createHash("sha256").update(resolvedWorkspaceDir).digest("hex");
  const sentinels = [
    join(
      stateDir,
      OPENCLAW_ATTESTATION_DIRNAME,
      `${key}${OPENCLAW_ATTESTATION_SUFFIX}`,
    ),
    `${resolvedWorkspaceDir}${OPENCLAW_ATTESTATION_SUFFIX}`,
  ];
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      Effect.all(
        sentinels.map((sentinel) =>
          fileSystem.makeDirectory(sentinel, { recursive: true }),
        ),
        { concurrency: sentinels.length, discard: true },
      ),
    ),
  );
}

/**
 * Materialize the OpenClaw state directory and its simulator-owned config.
 *
 * @param deps Value supplied to the operation.
 * @param input Input value to process.
 * @param stateDir Value supplied to the operation.
 * @param gatewayToken Private token shared with the scoped gateway client.
 * @internal
 * @returns The configure open claw state dir result.
 */
function configureOpenClawStateDir(
  deps: OpenClawProcessOptions,
  input: OpenClawProcessInput,
  stateDir: string,
  gatewayToken: Redacted.Redacted,
): Effect.Effect<
  void,
  unknown,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem | Path.Path
> {
  const seedOperatorAuth =
    input.seedOperatorAuth === false
      ? Effect.void
      : seedModelAuthProfile(stateDir);
  return Effect.all(
    [
      writeOpenClawConfig({
        stateDir,
        agentName: input.agentName,
        agentId: input.agentId,
        apiKey: input.apiKey,
        modelId: input.modelId,
        installMode: deps.installMode,
        mcpServers: deps.mcpServers,
        tools: input.tools,
        sandbox: input.sandbox,
        gatewayToken,
      }),
      seedWorkspaceFiles(openClawWorkspaceDir(stateDir), input.workspaceFiles),
      seedOperatorAuth,
      disarmOpenClawAttestationGuard(stateDir),
    ],
    { concurrency: 4, discard: true },
  ).pipe(Effect.zipRight(installConfiguredChannel(deps, stateDir)));
}

function installConfiguredChannel(
  deps: OpenClawProcessOptions,
  stateDir: string,
): Effect.Effect<
  void,
  unknown,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem | Path.Path
> {
  if (deps.installMode === "published") {
    return materializePublishedOpenClawPlugin({
      stateDir,
      openclawBin: deps.openclawBin,
    }).pipe(Effect.asVoid);
  }
  return assertWorkspaceChannelDist(deps.channelDistDir).pipe(
    Effect.zipRight(
      installChannelPlugin({
        stateDir,
        channelDistDir: deps.channelDistDir,
        extName: OPENCLAW_EXTENSION_NAME,
        // OpenClaw discovers channel plugins through this package-root manifest.
        extraPackageFiles: ["openclaw.plugin.json"],
      }),
    ),
    Effect.asVoid,
  );
}

/**
 * Workspace mode accepts local build output, including a node_modules symlink
 * whose real target is local, but never an installed package-store copy.
 * @param channelDistDir Value supplied to the operation.
 * @internal
 * @returns The assert workspace channel dist result.
 */
function assertWorkspaceChannelDist(channelDistDir: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.realPath(channelDistDir)),
    Effect.flatMap((resolvedChannelDistDir) =>
      resolvedChannelDistDir.split(sep).includes("node_modules")
        ? Effect.fail(
            new OpenClawInstallModeError({
              message:
                "OpenClaw workspace install mode requires local channel build output",
              channelDistDir,
              resolvedChannelDistDir,
            }),
          )
        : Effect.void,
    ),
    Effect.withSpan("assertWorkspaceChannelDist"),
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
      Effect.logWarning("failed to remove OpenClaw state directory", cause),
    ),
  );
}

function spawnConfiguredOpenClaw(options: {
  readonly deps: OpenClawProcessOptions;
  readonly stateDir: string;
  readonly input: OpenClawProcessInput;
  readonly port: number;
  readonly logBuffer: BoundedLogBuffer;
  readonly onStarted: (process: SpawnedProcess) => Effect.Effect<void>;
}): Effect.Effect<SpawnedProcess, Error, CommandExecutor.CommandExecutor> {
  return Effect.gen(function* () {
    const baseEnvironment = yield* baseChildEnvironmentConfig;
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
      cause instanceof Error
        ? cause
        : new Cause.UnknownException(cause, Inspectable.format(cause)),
    ),
  );
}

/**
 * Starts one configured OpenClaw gateway and hands its process, state
 * directory, log buffer, and logical port claim to the caller.
 *
 * ```mermaid
 * flowchart TD
 *   START["startOpenClawRuntimeEffect"]
 *   PORT["lease loopback port<br>close probe, retain logical claim"]
 *   STATE["create + configure isolated state dir"]
 *   MODE{"install mode"}
 *   WORKSPACE["workspace<br>validate + copy channel"]
 *   PUBLISHED["published<br>materialize pinned plugin"]
 *   PROCESS["start supervised process<br>exact environment + bounded logs"]
 *   HANDOFF["transfer resources to runtime handle"]
 *   RELEASE["failure or interruption<br>stop process + remove state + release claim"]
 *   START --> PORT --> STATE --> MODE
 *   MODE -->|workspace| WORKSPACE --> PROCESS
 *   MODE -->|published| PUBLISHED --> PROCESS
 *   PROCESS --> HANDOFF
 *   PORT -.-> RELEASE
 *   STATE -.-> RELEASE
 *   WORKSPACE -.-> RELEASE
 *   PUBLISHED -.-> RELEASE
 *   PROCESS -.-> RELEASE
 * ```
 *
 * Router-visible readiness remains the owning runtime's concern.
 * @internal
 */
const startOpenClawRuntimeEffect = Effect.fn("OpenClawProcess.start")(
  function* (deps: OpenClawProcessOptions, input: OpenClawProcessInput) {
    return yield* acquireOpenClawRuntimeHandle(deps, input).pipe(
      Effect.withSpan("startOpenClawRuntimeEffect"),
    );
  },
);

function acquireOpenClawRuntimeHandle(
  deps: OpenClawProcessOptions,
  input: OpenClawProcessInput,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.scoped(
      Effect.gen(function* () {
        const portClaim = yield* restore(leaseOpenClawPort());
        const lease: OpenClawSpawnLease = {
          process: null,
          committed: false,
        };
        const gatewayToken = yield* Effect.sync(makeOpenClawGatewayToken);
        const stateDir = yield* restore(allocateOpenClawStateDir(input));
        yield* Effect.addFinalizer(() =>
          lease.committed ? Effect.void : removeOpenClawStateDir(stateDir),
        );
        yield* restore(
          configureOpenClawStateDir(deps, input, stateDir, gatewayToken),
        );

        const logBuffer = new BoundedLogBuffer();
        const process = yield* restore(
          Effect.acquireReleaseInterruptible(
            spawnConfiguredOpenClaw({
              deps,
              stateDir,
              input,
              port: portClaim.port,
              logBuffer,
              onStarted: (started) =>
                captureSpawnedOpenClawProcess(lease, started),
            }),
            () => releaseOpenClawSpawnLease(lease),
          ),
        );
        return yield* commitOpenClawRuntimeHandle(lease, {
          process,
          stateDir,
          logBuffer,
          portClaim,
          gatewayToken,
          agentName: input.agentName,
        });
      }),
    ),
  );
}

function makeOpenClawGatewayToken(): Redacted.Redacted {
  return Redacted.make(
    randomBytes(OPENCLAW_GATEWAY_TOKEN_BYTES).toString("base64url"),
  );
}

function commitOpenClawRuntimeHandle(
  lease: OpenClawSpawnLease,
  handle: OpenClawRuntimeHandle,
): Effect.Effect<OpenClawRuntimeHandle> {
  return releasePortClaimWhenProcessEnds(handle.process, handle.portClaim).pipe(
    Effect.zipRight(handle.portClaim.transfer()),
    Effect.zipRight(
      Effect.sync(() => {
        lease.committed = true;
      }),
    ),
    Effect.as(handle),
  );
}

/**
 * Stops a running gateway and releases every resource in its handle.
 * @param handle Value supplied to the operation.
 * @returns The stop open claw runtime effect result.
 */
function stopOpenClawRuntimeEffect(
  handle: OpenClawRuntimeHandle,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.uninterruptible(
    stopSpawnedOpenClawProcess(handle.process).pipe(
      Effect.ensuring(handle.portClaim.release()),
      Effect.ensuring(removeOpenClawStateDir(handle.stateDir)),
      Effect.ensuring(
        Effect.sync(() => {
          Redacted.unsafeWipe(handle.gatewayToken);
        }),
      ),
    ),
  ).pipe(Effect.withSpan("stopOpenClawRuntimeEffect"));
}

function acquireScopedOpenClawRuntimeHandle(
  deps: OpenClawProcessOptions,
  input: OpenClawProcessInput,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const handle = yield* restore(startOpenClawRuntimeEffect(deps, input));
      yield* Effect.addFinalizer(openClawRuntimeFinalizer(handle));
      return handle;
    }),
  );
}

function openClawRuntimeFinalizer(handle: OpenClawRuntimeHandle) {
  return () => stopOpenClawRuntimeEffect(handle);
}

function openClawProcessSession(
  handle: OpenClawRuntimeHandle,
): OpenClawProcessSession {
  return {
    exitCode: Fiber.join(handle.process.exitFiber),
    output: () =>
      handle.logBuffer.text
        .split(Redacted.value(handle.gatewayToken))
        .join(OPENCLAW_GATEWAY_TOKEN_REDACTION_MARKER),
    gatewayUrl: `ws://127.0.0.1:${handle.portClaim.port}`,
    gatewayToken: handle.gatewayToken,
    agentName: handle.agentName,
  };
}

/**
 * Acquires one gateway in the caller's Scope and exposes only process
 * observations needed by process-backed runtimes.
 * @internal
 */
export const acquireOpenClawProcess = Effect.fn("OpenClawProcess.acquire")(
  (deps: OpenClawProcessOptions, input: OpenClawProcessInput) =>
    acquireScopedOpenClawRuntimeHandle(deps, input).pipe(
      Effect.map(openClawProcessSession),
    ),
);

/**
 * Resolves omitted package locations into exact process host configuration.
 * @param input Input value to process.
 * @internal
 * @returns The resolve open claw process options result.
 */
export function resolveOpenClawProcessOptions(
  input: OpenClawProcessOptionOverrides,
): OpenClawProcessOptions {
  return {
    openclawBin:
      input.openclawBin ?? resolveInstalledPackageBin("openclaw", "openclaw"),
    channelDistDir: input.channelDistDir ?? resolveOpenClawChannelDistDir(),
    installMode: input.installMode,
    ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
  };
}

function resolveOpenClawChannelDistDir(): string {
  return join(
    resolveInstalledPackageRoot("@moltzap/openclaw-channel", import.meta.url),
    "dist",
  );
}

/**
 * Selects an available loopback port and retains a process-local logical
 * claim. The probe listener closes before this acquisition returns so the
 * OpenClaw child never races a listener owned by its parent.
 * @param options Options that control the operation.
 * @internal
 * @returns The lease open claw port result.
 */
export function leaseOpenClawPort(
  options: OpenClawPortLeaseOptions = {},
): Effect.Effect<
  OpenClawPortClaim,
  PortAllocationFailed | SocketServer.SocketServerError,
  Scope.Scope
> {
  const candidatePort = options.candidatePort ?? (() => EPHEMERAL_PORT);
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const claim = yield* restore(claimOpenClawPort(candidatePort));
      yield* Effect.addFinalizer(() => claim.closeStartupLease());
      return claim;
    }),
  ).pipe(Effect.withSpan("leaseOpenClawPort"));
}

function claimOpenClawPort(
  candidatePort: () => number,
): Effect.Effect<
  LeasedOpenClawPortClaim,
  PortAllocationFailed | SocketServer.SocketServerError
> {
  return Effect.suspend(() => {
    const requestedPort = candidatePort();
    return requestedPort !== EPHEMERAL_PORT &&
      CLAIMED_OPENCLAW_PORTS.has(requestedPort)
      ? claimOpenClawPort(candidatePort)
      : bindOpenClawPortCandidate(requestedPort);
  }).pipe(
    Effect.flatMap((candidate) =>
      Effect.sync(() => {
        if (CLAIMED_OPENCLAW_PORTS.has(candidate.port)) {
          return false;
        }
        CLAIMED_OPENCLAW_PORTS.add(candidate.port);
        return true;
      }).pipe(
        Effect.flatMap((claimed) =>
          claimed
            ? Effect.succeed(makeOpenClawPortClaim(candidate))
            : Effect.suspend(() => claimOpenClawPort(candidatePort)),
        ),
      ),
    ),
  );
}

function bindOpenClawPortCandidate(
  requestedPort: number,
): Effect.Effect<
  BoundOpenClawPort,
  PortAllocationFailed | SocketServer.SocketServerError
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* acquireOpenClawPortProbe(requestedPort);
      if (server.address._tag !== "TcpAddress") {
        return yield* new PortAllocationFailed({
          message: "TCP port allocation returned a non-TCP address",
          cause: server.address,
        });
      }
      return { port: server.address.port };
    }),
  );
}

function acquireOpenClawPortProbe(requestedPort: number) {
  // The socket constructor races listener startup against error observation.
  // Its interruptible child can cancel that internal race, while the joined
  // parent keeps external cancellation from splitting listen from teardown.
  return Effect.uninterruptible(
    NodeSocketServer.make({
      host: "127.0.0.1",
      port: requestedPort,
    }).pipe(Effect.interruptible, Effect.fork, Effect.flatMap(Fiber.join)),
  );
}

function makeOpenClawPortClaim(
  candidate: BoundOpenClawPort,
): LeasedOpenClawPortClaim {
  const state: OpenClawPortClaimState = {
    transferred: false,
    released: false,
  };
  const releaseLogicalClaim = Effect.sync(() => {
    if (state.released) {
      return;
    }
    state.released = true;
    CLAIMED_OPENCLAW_PORTS.delete(candidate.port);
  });
  return {
    port: candidate.port,
    transfer: () =>
      Effect.sync(() => {
        state.transferred = true;
      }),
    release: () => releaseLogicalClaim,
    closeStartupLease: () =>
      Effect.suspend(() =>
        state.transferred ? Effect.void : releaseLogicalClaim,
      ),
  };
}

// --- Config and plugin install (module-private) ---

function writeOpenClawConfig(opts: {
  stateDir: string;
  agentName: AgentName;
  agentId: OpenClawProcessInput["agentId"];
  apiKey: OpenClawProcessInput["apiKey"];
  modelId?: string;
  installMode: InstallMode;
  mcpServers?: readonly McpServerMount[];
  tools?: OpenClawToolsConfig;
  sandbox?: OpenClawSandboxConfig;
  gatewayToken: Redacted.Redacted;
}): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceDir = openClawWorkspaceDir(opts.stateDir);
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

/**
 * Render the optional MCP server mounts into OpenClaw configuration.
 *
 * @param mcpServers Value supplied to the operation.
 * @internal
 * @returns The mcp config section result.
 */
function mcpConfigSection(
  mcpServers?: readonly McpServerMount[],
): Pick<OpenClawConfig, "mcp"> {
  if (mcpServers === undefined || mcpServers.length === 0) {
    return {};
  }
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

/**
 * Builds the simulator-owned native OpenClaw configuration.
 * @param opts Runtime and channel configuration.
 * @param opts.agentName Stable roster identity presented to OpenClaw.
 * @param opts.modelId Optional native model override.
 * @param opts.installMode Package source selected for the channel plugin.
 * @param opts.mcpServers Optional native MCP server definitions.
 * @param opts.tools Optional native tool policy.
 * @param opts.sandbox Optional native sandbox policy.
 * @param opts.gatewayToken Secret used by the owner-local gateway.
 * @param workspaceDir Isolated workspace for the OpenClaw agent.
 * @internal
 * @returns The complete native OpenClaw configuration.
 */
export function buildOpenClawConfig(
  opts: {
    readonly agentName: AgentName;
    readonly modelId?: string;
    readonly installMode: InstallMode;
    readonly mcpServers?: readonly McpServerMount[];
    readonly tools?: OpenClawToolsConfig;
    readonly sandbox?: OpenClawSandboxConfig;
    readonly gatewayToken: Redacted.Redacted;
  },
  workspaceDir: string,
): OpenClawConfig {
  const pluginTrust =
    opts.installMode === "workspace"
      ? {
          // Workspace copies have no npm install provenance, so their
          // extension trust is pinned explicitly.
          plugins: { allow: [OPENCLAW_EXTENSION_NAME] },
        }
      : {};
  return {
    ...mcpConfigSection(opts.mcpServers),
    agents: {
      defaults: {
        model: { primary: opts.modelId ?? DEFAULT_OPENCLAW_MODEL_ID },
        workspace: workspaceDir,
        compaction: { mode: "safeguard" },
        ...(opts.sandbox === undefined ? {} : { sandbox: opts.sandbox }),
        // Left unset, openclaw seeds BOOTSTRAP.md into the empty per-agent
        // workspace and runs its first-run onboarding ritual, whose scripted
        // opening line the agent sends in place of answering the step.
        skipBootstrap: true,
      },
      list: [{ id: opts.agentName, default: true }],
    },
    ...(opts.tools === undefined ? {} : { tools: opts.tools }),
    commands: { native: "auto", nativeSkills: "auto", restart: true },
    ...pluginTrust,
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
            id: SIMULATOR_PROFILE_NAME,
            agentName: opts.agentName,
          },
        ],
      },
    },
    ...openClawGatewayConfig(opts.gatewayToken),
  };
}

function openClawGatewayConfig(
  gatewayToken: Redacted.Redacted,
): Pick<OpenClawConfig, "gateway"> {
  return {
    gateway: {
      mode: "local",
      auth: {
        mode: "token",
        token: Redacted.value(gatewayToken),
      },
    },
  };
}

/* eslint-enable jsdoc/text-escaping -- Restore strict defaults after the scoped file-level exception. */
