/** @file NanoClaw runtime directories and supervised process lifetime. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execPath } from "node:process";
import { Command, FileSystem } from "@effect/platform";
import type {
  CommandExecutor,
  ExitCode,
  Process,
} from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import { httpBaseUrl, type ServerBaseUrl } from "@moltzap/protocol/network";
import {
  Data,
  Duration,
  Effect,
  Exit,
  type Fiber,
  Option,
  Scope,
  Stream,
} from "effect";
import {
  seedWorkspaceFiles,
  SIMULATOR_PROFILE_NAME,
  writeMoltZapProfileConfig,
} from "../workspace.js";
import type { NanoclawRuntimeInstall } from "./install.js";
import { MOLTZAP_SIMULATOR_CACHE_ROOT } from "../cache.js";
import {
  type BaseChildEnvironment,
  baseChildEnvironmentConfig,
  BoundedLogBuffer,
  escalatingKill,
  makeExactEnvironmentCommand,
  makeCommandHelpers,
  type ProcessTreeCleanup,
  startSupervisedProcess,
} from "../command.js";
import { ensureOnecliRunning, ONECLI_GATEWAY_URL } from "./onecli.js";

// NanoClaw waits up to ten seconds for its queue to drain before disconnecting.
// Leave margin for channel disconnect and process exit before escalating.
const NANOCLAW_TERM_WAIT_MS = 12_000;
const NANOCLAW_KILL_WAIT_MS = 5_000;
const NANOCLAW_INSTALL_SLUG_LENGTH = 8;
const NANOCLAW_INSTALL_LABEL_KEY = "nanoclaw-install";
const DOCKER_COMMAND = "docker";
const NANOCLAW_DOCKER_COMMAND_TIMEOUT_MS = 10_000;
const NANOCLAW_EVAL_PROVISION_TIMEOUT_MS = 30_000;
const NANOCLAW_EVAL_PROVISION_ENTRYPOINT = "dist/moltzap-eval-provision.js";
/** Provides the nanoclaw eval agent group id runtime value. */
export const NANOCLAW_EVAL_AGENT_GROUP_ID = "eval-agent";

/** Describes nanoclaw runtime handle. */
export interface NanoclawRuntimeHandle {
  proc: Process;
  scope: Scope.CloseableScope;
  exitFiber: Fiber.RuntimeFiber<ExitCode, PlatformError>;
  processTreeCleanup?: ProcessTreeCleanup;
  runtimeDir: string;
  logs: BoundedLogBuffer;
}

interface StartNanoclawRuntimeOptions {
  agentName: string;
  agentId: AgentId;
  apiKey: AgentKey;
  serverUrl: ServerBaseUrl;
  autoRegisterConversations: boolean;
  workspaceFiles?: ReadonlyArray<{
    relativePath: string;
    content: string;
  }>;
  /** Honored through the eval agent group's container config (moltzap channel). */
  modelId?: string;
  /** Stdio MCP servers mounted into the container via the container config. */
  mcpServers?: ReadonlyArray<{
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  }>;
}

/** Describes nanoclaw process plan. */
export interface NanoclawProcessPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

class NanoclawRuntimeProcessError extends Data.TaggedError(
  "NanoclawRuntimeProcessError",
)<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.reason;
  }
}

interface StartedNanoclawProcess {
  readonly proc: Process;
  readonly scope: Scope.CloseableScope;
  readonly exitFiber: Fiber.RuntimeFiber<ExitCode, PlatformError>;
  readonly processTreeCleanup: ProcessTreeCleanup;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function toRuntimeError(message: string, cause?: unknown) {
  return new NanoclawRuntimeProcessError({
    reason: message,
    ...(cause === undefined ? {} : { cause }),
  });
}

const { fsEffect } = makeCommandHelpers(toRuntimeError);

// Runtime dirs are docker bind-mount sources (agent-runner src, group and
// session dirs), and macOS VM-backed engines only share paths under the
// user home by default — the system temp dir is invisible to containers —
// so per-agent dirs live under the simulator cache root instead.
const NANOCLAW_RUNTIME_DIR_ROOT = join(
  MOLTZAP_SIMULATOR_CACHE_ROOT,
  "nanoclaw-runtimes",
);

// Hard-killed runs skip teardown, and outside the OS temp dir no reaper
// backstops the leak. The generous age gate exists because a live agent's
// root mtime never refreshes — only dirs no plausible run still owns are
// swept.
const STALE_RUNTIME_DIR_MAX_AGE_MS = 7 * 86_400_000;

function sweepStaleRuntimeDirs() {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      Effect.gen(function* () {
        if (!(yield* fileSystem.exists(NANOCLAW_RUNTIME_DIR_ROOT))) {
          return;
        }
        const entries = yield* fileSystem.readDirectory(
          NANOCLAW_RUNTIME_DIR_ROOT,
        );
        const cutoff = Date.now() - STALE_RUNTIME_DIR_MAX_AGE_MS;
        for (const entry of entries) {
          const dir = join(NANOCLAW_RUNTIME_DIR_ROOT, entry);
          const info = yield* fileSystem.stat(dir);
          const mtime = Option.getOrNull(info.mtime);
          if (mtime !== null && mtime.getTime() <= cutoff) {
            yield* fileSystem.remove(dir, { recursive: true, force: true });
          }
        }
      }),
    ),
    Effect.catchAll((cause) =>
      Effect.logWarning("failed to sweep stale nanoclaw runtime dirs", cause),
    ),
    Effect.withSpan("sweepStaleRuntimeDirs"),
  );
}

function createNanoclawRuntimeDir() {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fsEffect(
        "create nanoclaw runtime directory",
        fileSystem
          .makeDirectory(NANOCLAW_RUNTIME_DIR_ROOT, { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.makeTempDirectory({
                directory: NANOCLAW_RUNTIME_DIR_ROOT,
                prefix: "moltzap-nanoclaw-runtime-",
              }),
            ),
          ),
      ),
    ),
  );
}

function writeRuntimeWorkspaceFiles(
  runtimeDir: string,
  workspaceFiles: StartNanoclawRuntimeOptions["workspaceFiles"],
) {
  return seedWorkspaceFiles(
    join(runtimeDir, "container/skills"),
    workspaceFiles,
  ).pipe(
    Effect.mapError((cause) =>
      toRuntimeError("seed nanoclaw workspace files", cause),
    ),
  );
}

function seedNanoclawRuntimeDir(
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      Effect.all(
        [
          // The runtime's cwd doubles as NanoClaw's PROJECT_ROOT: the
          // startup tripwire reads ./package.json and the sanctioned-upgrade
          // marker in data/ (stamped at install time through upstream's own
          // writer), so both ride along with container/ and scripts/.
          ...["container", "scripts", "data"].map((directory) =>
            fsEffect(
              `copy nanoclaw ${directory} into isolated runtime`,
              fileSystem.copy(
                join(install.cacheDir, directory),
                join(runtimeDir, directory),
                { overwrite: true },
              ),
            ),
          ),
          fsEffect(
            "copy nanoclaw manifest into isolated runtime",
            fileSystem.copyFile(
              join(install.cacheDir, "package.json"),
              join(runtimeDir, "package.json"),
            ),
          ),
          fsEffect(
            "create nanoclaw runtime temp directory",
            fileSystem.makeDirectory(join(runtimeDir, "tmp"), {
              recursive: true,
            }),
          ),
        ],
        { concurrency: 5, discard: true },
      ),
    ),
  );
}

function buildNanoclawChildEnvironment(
  opts: StartNanoclawRuntimeOptions,
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
  baseEnvironment: BaseChildEnvironment,
): Readonly<Record<string, string>> {
  return {
    ...baseEnvironment,
    MOLTZAP_PROFILE: SIMULATOR_PROFILE_NAME,
    MOLTZAP_CONFIG_HOME: join(runtimeDir, ".moltzap"),
    MOLTZAP_SERVER_URL: httpBaseUrl(opts.serverUrl),
    MOLTZAP_EVAL_MODE: opts.autoRegisterConversations ? "1" : "0",
    CONTAINER_RUNTIME: "docker",
    CONTAINER_IMAGE: install.containerImage,
    ONECLI_URL: ONECLI_GATEWAY_URL,
    // The OneCLI SDK stages its gateway CA/credential bind-mount sources
    // under os.tmpdir(); pointing TMPDIR into the runtime dir keeps them
    // docker-shareable on macOS (the OS temp root is invisible to
    // VM-backed engines).
    TMPDIR: join(runtimeDir, "tmp"),
    LOG_LEVEL: "info",
  };
}

/**
 * The simulator's per-agent model and MCP mounts, as the env pairs the eval provisioner materializes into the container config.
 * @param opts Value supplied to the operation.
 * @returns The created container defaults environment.
 */
function buildContainerDefaultsEnvironment(
  opts: StartNanoclawRuntimeOptions,
): Readonly<Record<string, string>> {
  return {
    ...(opts.modelId === undefined || opts.modelId.length === 0
      ? {}
      : { MOLTZAP_AGENT_MODEL: opts.modelId }),
    ...(opts.mcpServers === undefined || opts.mcpServers.length === 0
      ? {}
      : {
          MOLTZAP_MCP_SERVERS: JSON.stringify(
            Object.fromEntries(
              opts.mcpServers.map((server) => [
                server.name,
                {
                  command: server.command,
                  args: [...server.args],
                  env: { ...server.env },
                },
              ]),
            ),
          ),
        }),
  };
}

/**
 * Creates nanoclaw process plan.
 * @param opts Value supplied to the operation.
 * @param runtimeDir Value supplied to the operation.
 * @param install Value supplied to the operation.
 * @param baseEnvironment Value supplied to the operation.
 * @returns The created nanoclaw process plan.
 */
export function buildNanoclawProcessPlan(
  opts: StartNanoclawRuntimeOptions,
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
  baseEnvironment: BaseChildEnvironment,
): NanoclawProcessPlan {
  const entrypoint = join(install.cacheDir, "dist/index.js");
  return {
    command: "node",
    args: [entrypoint],
    cwd: runtimeDir,
    env: {
      ...buildContainerDefaultsEnvironment(opts),
      ...buildNanoclawChildEnvironment(
        opts,
        runtimeDir,
        install,
        baseEnvironment,
      ),
    },
  };
}

/**
 * The provision plan carries the same container defaults as the runtime
 * plan: the provisioner applies `MOLTZAP_AGENT_MODEL` /
 * `MOLTZAP_MCP_SERVERS` to the seeded container-config row before the
 * first container spawn reads it.
 * @param opts Value supplied to the operation.
 * @param runtimeDir Value supplied to the operation.
 * @param install Value supplied to the operation.
 * @param baseEnvironment Value supplied to the operation.
 * @internal
 * @returns The created nanoclaw eval provision plan.
 */
export function buildNanoclawEvalProvisionPlan(
  opts: StartNanoclawRuntimeOptions,
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
  baseEnvironment: BaseChildEnvironment,
): NanoclawProcessPlan {
  return {
    command: "node",
    args: [
      join(install.cacheDir, NANOCLAW_EVAL_PROVISION_ENTRYPOINT),
      NANOCLAW_EVAL_AGENT_GROUP_ID,
      opts.agentName,
      NANOCLAW_EVAL_AGENT_GROUP_ID,
    ],
    cwd: runtimeDir,
    env: {
      ...buildContainerDefaultsEnvironment(opts),
      ...buildNanoclawChildEnvironment(
        opts,
        runtimeDir,
        install,
        baseEnvironment,
      ),
    },
  };
}

function makeNanoclawCommand(
  opts: StartNanoclawRuntimeOptions,
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
) {
  return baseChildEnvironmentConfig.pipe(
    Effect.map((baseEnvironment) =>
      makeExactEnvironmentCommand({
        ...buildNanoclawProcessPlan(opts, runtimeDir, install, baseEnvironment),
        cleanupTreeOnExit: true,
      }),
    ),
  );
}

function provisionNanoclawEvalAgent(
  opts: StartNanoclawRuntimeOptions,
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
) {
  if (!opts.autoRegisterConversations) {
    return Effect.void;
  }
  return baseChildEnvironmentConfig.pipe(
    Effect.map((baseEnvironment) => {
      // One-shot provisioner: it writes sqlite and exits, so the inherited
      // operator environment is harmless and the exact-environment launcher
      // hop is unnecessary.
      const plan = buildNanoclawEvalProvisionPlan(
        opts,
        runtimeDir,
        install,
        baseEnvironment,
      );
      return Command.make(execPath, ...plan.args).pipe(
        Command.env(plan.env),
        Command.workingDirectory(plan.cwd),
      );
    }),
    Effect.flatMap((command) =>
      runCommand(command, {
        timeoutMs: NANOCLAW_EVAL_PROVISION_TIMEOUT_MS,
        timeoutMessage: "timed out provisioning NanoClaw eval agent",
      }),
    ),
    Effect.flatMap((result) =>
      requireSuccessfulCommand("provision NanoClaw eval agent", result),
    ),
    Effect.mapError((cause) =>
      cause instanceof NanoclawRuntimeProcessError
        ? cause
        : toRuntimeError("provision NanoClaw eval agent", cause),
    ),
    Effect.withSpan("provisionNanoclawEvalAgent"),
  );
}

function writeNanoclawMoltZapProfileConfig(
  opts: StartNanoclawRuntimeOptions,
  runtimeDir: string,
) {
  const configDir = join(runtimeDir, ".moltzap");
  return writeMoltZapProfileConfig(configDir, opts).pipe(
    Effect.mapError((cause) =>
      toRuntimeError(`write moltzap profile config ${configDir}`, cause),
    ),
  );
}

function startNanoclawProcess(
  opts: StartNanoclawRuntimeOptions,
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
  logs: BoundedLogBuffer,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const command = yield* makeNanoclawCommand(opts, runtimeDir, install);
      const scope = yield* Scope.make();
      return yield* restore(
        initializeNanoclawProcess(command, scope, logs),
      ).pipe(
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
    }),
  ).pipe(
    Effect.mapError((cause) => toRuntimeError("spawn nanoclaw runtime", cause)),
  );
}

function initializeNanoclawProcess(
  command: Command.Command,
  scope: Scope.CloseableScope,
  logs: BoundedLogBuffer,
) {
  return startSupervisedProcess(
    command,
    scope,
    (chunk) => {
      logs.append(chunk);
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
          scope,
          exitFiber,
          processTreeCleanup,
        }) satisfies StartedNanoclawProcess,
    ),
  );
}

// Spawn commits as soon as the process starts; readiness — server-confirmed
// authentication raced against subprocess exit, bounded by the caller's
// budget — lives entirely in the owning runtime.
function startConfiguredNanoclawRuntime(
  opts: StartNanoclawRuntimeOptions,
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
) {
  return Effect.gen(function* () {
    yield* seedNanoclawRuntimeDir(runtimeDir, install);
    yield* writeRuntimeWorkspaceFiles(runtimeDir, opts.workspaceFiles);
    yield* writeNanoclawMoltZapProfileConfig(opts, runtimeDir);
    yield* provisionNanoclawEvalAgent(opts, runtimeDir, install);

    const logs = new BoundedLogBuffer();
    const started = yield* startNanoclawProcess(
      opts,
      runtimeDir,
      install,
      logs,
    );
    return { ...started, runtimeDir, logs };
  });
}

/**
 * Executes the start nanoclaw runtime effect operation.
 * @param opts Value supplied to the operation.
 * @param install Value supplied to the operation.
 * @returns The start nanoclaw runtime effect result.
 */
export const startNanoclawRuntimeEffect = Effect.fn(
  "startNanoclawRuntimeEffect",
)(function* (
  opts: StartNanoclawRuntimeOptions,
  install: NanoclawRuntimeInstall,
) {
  yield* ensureOnecliRunning(toRuntimeError);
  yield* sweepStaleRuntimeDirs();
  const runtimeDir = yield* createNanoclawRuntimeDir();
  return yield* startConfiguredNanoclawRuntime(opts, runtimeDir, install).pipe(
    Effect.onError(() => removeNanoclawRuntimeDir(runtimeDir)),
  );
});

/**
 * Executes the stop nanoclaw runtime effect operation.
 * @param handle Value supplied to the operation.
 * @returns The stop nanoclaw runtime effect result.
 */
export function stopNanoclawRuntimeEffect(
  handle: NanoclawRuntimeHandle,
): Effect.Effect<
  void,
  NanoclawRuntimeProcessError,
  CommandExecutor | FileSystem.FileSystem
> {
  return Effect.uninterruptible(
    stopNanoclawProcess(handle).pipe(
      Effect.ensuring(Scope.close(handle.scope, Exit.succeed(undefined))),
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- cleanup runs after module initialization.
      Effect.ensuring(sweepNanoclawContainers(handle.runtimeDir)),
      Effect.ensuring(removeNanoclawRuntimeDir(handle.runtimeDir)),
    ),
  ).pipe(Effect.withSpan("stopNanoclawRuntimeEffect"));
}

/**
 * Derive NanoClaw's stable installation label from a runtime directory.
 *
 * @param runtimeDir Value supplied to the operation.
 * @internal
 * @returns The nanoclaw install slug result.
 */
export function nanoclawInstallSlug(runtimeDir: string): string {
  // eslint-disable-next-line sonarjs/hashing -- Matches NanoClaw's non-security checkout identifier.
  return createHash("sha1")
    .update(runtimeDir)
    .digest("hex")
    .slice(0, NANOCLAW_INSTALL_SLUG_LENGTH);
}

function nanoclawInstallLabel(runtimeDir: string): string {
  return `${NANOCLAW_INSTALL_LABEL_KEY}=${nanoclawInstallSlug(runtimeDir)}`;
}

/**
 * Build the Docker command that lists containers owned by one NanoClaw runtime.
 *
 * @param runtimeDir Value supplied to the operation.
 * @internal
 * @returns The created nanoclaw container list command.
 */
export function buildNanoclawContainerListCommand(
  runtimeDir: string,
): Command.Command {
  return Command.make(
    DOCKER_COMMAND,
    "ps",
    "--quiet",
    "--filter",
    `label=${nanoclawInstallLabel(runtimeDir)}`,
  );
}

/**
 * Build the Docker command that removes owned NanoClaw containers.
 *
 * @param containerIds Value supplied to the operation.
 * @internal
 * @returns The created nanoclaw container remove command.
 */
export function buildNanoclawContainerRemoveCommand(
  containerIds: readonly string[],
): Command.Command {
  return Command.make(DOCKER_COMMAND, "rm", "--force", ...containerIds);
}

function captureCommandStream(
  stream: Stream.Stream<Uint8Array, unknown>,
): Effect.Effect<string, unknown> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.runFold("", (output, chunk) => output + chunk),
  );
}

interface RunCommandOptions {
  readonly timeoutMs: number;
  readonly timeoutMessage: string;
}

const DOCKER_RUN_COMMAND_OPTIONS: RunCommandOptions = {
  timeoutMs: NANOCLAW_DOCKER_COMMAND_TIMEOUT_MS,
  timeoutMessage: "timed out sweeping NanoClaw runtime containers",
};

function runCommand(command: Command.Command, options: RunCommandOptions) {
  return Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Command.start(command);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          captureCommandStream(process.stdout),
          captureCommandStream(process.stderr),
          process.exitCode,
        ],
        { concurrency: 3 },
      );
      return {
        stdout,
        stderr,
        exitCode: Number(exitCode),
      } satisfies CommandResult;
    }),
  ).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(options.timeoutMs),
      onTimeout: () => toRuntimeError(options.timeoutMessage),
    }),
    Effect.interruptible,
  );
}

function requireSuccessfulCommand(
  operation: string,
  result: CommandResult,
): Effect.Effect<void, NanoclawRuntimeProcessError> {
  return result.exitCode === 0
    ? Effect.void
    : Effect.fail(
        toRuntimeError(
          `${operation} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
        ),
      );
}

const sweepNanoclawContainers = Effect.fn("sweepNanoclawContainers")(
  function* (runtimeDir: string) {
    const listResult = yield* runCommand(
      buildNanoclawContainerListCommand(runtimeDir),
      DOCKER_RUN_COMMAND_OPTIONS,
    );
    yield* requireSuccessfulCommand("list NanoClaw containers", listResult);
    const containerIds = listResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (containerIds.length === 0) {
      return;
    }

    const removeResult = yield* runCommand(
      buildNanoclawContainerRemoveCommand(containerIds),
      DOCKER_RUN_COMMAND_OPTIONS,
    );
    yield* requireSuccessfulCommand("remove NanoClaw containers", removeResult);
  },
  Effect.catchAll((cause) =>
    Effect.logWarning("failed to sweep NanoClaw runtime containers", cause),
  ),
);

function stopNanoclawProcess(handle: NanoclawRuntimeHandle) {
  return escalatingKill(
    handle.proc,
    handle.exitFiber,
    {
      termWaitMs: NANOCLAW_TERM_WAIT_MS,
      killWaitMs: NANOCLAW_KILL_WAIT_MS,
    },
    handle.processTreeCleanup,
  );
}

function removeNanoclawRuntimeDir(runtimeDir: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.remove(runtimeDir, { recursive: true, force: true }),
    ),
    Effect.catchAll((cause) =>
      Effect.logWarning("failed to remove NanoClaw runtime directory", cause),
    ),
  );
}
