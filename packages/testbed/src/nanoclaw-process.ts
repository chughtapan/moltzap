/**
 * Internal NanoClaw process helpers for the testbed runtime adapter.
 *
 * Installation and cache promotion live in `nanoclaw-install.ts`; this module
 * owns only isolated runtime directories and subprocess supervision.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import {
  Command,
  FileSystem,
  HttpClient,
  HttpClientRequest,
  Path,
} from "@effect/platform";
import type { Process } from "@effect/platform/CommandExecutor";
import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import {
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Scope,
  Stream,
} from "effect";
import {
  seedWorkspaceFiles,
  TESTBED_PROFILE_NAME,
  writeMoltZapProfileConfig,
} from "./channel-plugin-install.js";
import { type NanoclawRuntimeInstall } from "./nanoclaw-install.js";
import { MOLTZAP_TESTBED_CACHE_ROOT } from "./immutable-cache.js";
import {
  type BaseChildEnvironment,
  BaseChildEnvironmentConfig,
  BoundedLogBuffer,
  escalatingKill,
  makeExactEnvironmentCommand,
  makeCommandHelpers,
  type ProcessTreeCleanup,
  startSupervisedProcess,
} from "./child-process.js";
import { runCommandWithExclusiveFileLock } from "./file-lock.js";

// OneCLI gateway — nanoclaw's container-runner calls this for per-container
// credential injection. Running locally from ~/.onecli/docker-compose.yml; the
// service answers both the dashboard and /api/container-config on this one
// port. Install: curl -fsSL https://onecli.sh/install | sh
const ONECLI_URL = "http://127.0.0.1:10254";
const ONECLI_COMPOSE_PATH = join(homedir(), ".onecli/docker-compose.yml");
const ONECLI_START_LOCK_PATH = join(
  homedir(),
  ".onecli/moltzap-testbed-start.lock",
);
const ONECLI_START_PERMIT = Effect.runSync(Effect.makeSemaphore(1));

// NanoClaw waits up to ten seconds for its queue to drain before disconnecting.
// Leave margin for channel disconnect and process exit before escalating.
const NANOCLAW_TERM_WAIT_MS = 12_000;
const NANOCLAW_KILL_WAIT_MS = 5_000;
const ONECLI_PROBE_TIMEOUT_MS = 2_000;
const ONECLI_READY_PROBE_LIMIT = 20;
const ONECLI_READY_PROBE_INTERVAL_MS = 500;
const ONECLI_COMPOSE_TIMEOUT_MS = 120_000;
const MILLISECONDS_PER_SECOND = 1_000;
const NANOCLAW_INSTALL_SLUG_LENGTH = 8;
const NANOCLAW_INSTALL_LABEL_KEY = "nanoclaw-install";
const DOCKER_COMMAND = "docker";
const NANOCLAW_DOCKER_COMMAND_TIMEOUT_MS = 10_000;
const NANOCLAW_EVAL_PROVISION_TIMEOUT_MS = 30_000;
const NANOCLAW_EVAL_PROVISION_ENTRYPOINT = "dist/moltzap-eval-provision.js";
export const NANOCLAW_EVAL_AGENT_GROUP_ID = "eval-agent";

export interface NanoclawRuntimeHandle {
  proc: Process;
  scope: Scope.CloseableScope;
  exitFiber: Fiber.RuntimeFiber<number, never>;
  processTreeCleanup?: ProcessTreeCleanup;
  runtimeDir: string;
  logs: BoundedLogBuffer;
}

interface StartNanoclawRuntimeOptions {
  agentName: string;
  agentId: AgentId;
  apiKey: AgentKey;
  serverUrl: string;
  autoRegisterConversations: boolean;
  workspaceFiles?: ReadonlyArray<{
    relativePath: string;
    content: string;
  }>;
}

export interface NanoclawProcessPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
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
  readonly exitFiber: Fiber.RuntimeFiber<number, never>;
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

function isOnecliReachable(): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    // filterStatusOk: a 404/500 — or an unrelated process squatting on the
    // port — must read as unreachable, not as a healthy gateway.
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    yield* client.execute(
      HttpClientRequest.get(`${ONECLI_URL}/api/container-config`),
    );
    return true;
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(ONECLI_PROBE_TIMEOUT_MS),
      onTimeout: () => new Error("OneCLI reachability probe timed out"),
    }),
    Effect.provide(NodeHttpClient.layer),
    Effect.catchAll((reachabilityErr) =>
      reachabilityErr instanceof Error &&
      reachabilityErr.message.includes("timed out")
        ? Effect.succeed(false)
        : Effect.logWarning(
            "failed to probe OneCLI reachability",
            reachabilityErr,
          ).pipe(Effect.as(false)),
    ),
  );
}

function ensureOnecliRunning(): Effect.Effect<
  void,
  NanoclawRuntimeProcessError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const reachable = yield* isOnecliReachable();
    if (reachable) return;

    const fileSystem = yield* FileSystem.FileSystem;
    const composeFileExists = yield* fsEffect(
      `check OneCLI compose file ${ONECLI_COMPOSE_PATH}`,
      fileSystem.exists(ONECLI_COMPOSE_PATH),
    );
    if (!composeFileExists) {
      return yield* Effect.fail(
        toRuntimeError(
          `OneCLI gateway not running and not installed at ${ONECLI_COMPOSE_PATH}. ` +
            `Nanoclaw requires OneCLI to inject credentials into agent subcontainers. ` +
            `Install once with:\n\n  curl -fsSL https://onecli.sh/install | sh\n\n` +
            `Then open http://127.0.0.1:10254 and add your Anthropic credentials.`,
        ),
      );
    }

    yield* ONECLI_START_PERMIT.withPermits(1)(startOnecliUnderLock());
  });
}

function startOnecliUnderLock(): Effect.Effect<
  void,
  NanoclawRuntimeProcessError
> {
  return Effect.gen(function* () {
    // The in-process permit makes this probe suppress redundant compose work
    // locally; the native lock still serializes compose across processes.
    if (yield* isOnecliReachable()) return;
    yield* runOnecliComposeUnderLock();
    yield* waitForOnecliReadiness();
  });
}

function runOnecliComposeUnderLock() {
  return runCommandWithExclusiveFileLock(
    { path: ONECLI_START_LOCK_PATH },
    {
      command: DOCKER_COMMAND,
      args: [
        "compose",
        "-p",
        "onecli",
        "-f",
        ONECLI_COMPOSE_PATH,
        "up",
        "-d",
        "--wait",
      ],
    },
  ).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(ONECLI_COMPOSE_TIMEOUT_MS),
      onTimeout: () => toRuntimeError("OneCLI compose startup timed out"),
    }),
    Effect.mapError((cause) =>
      cause instanceof NanoclawRuntimeProcessError
        ? cause
        : toRuntimeError("start OneCLI under the host lock", cause),
    ),
    Effect.flatMap((composeExitCode) =>
      Number(composeExitCode) === 0
        ? Effect.void
        : Effect.fail(
            toRuntimeError(
              `OneCLI compose startup failed with exit code ${composeExitCode}`,
            ),
          ),
    ),
  );
}

function waitForOnecliReadiness() {
  return Effect.gen(function* () {
    // `--wait` returns when healthchecks pass, but give the HTTP listener a
    // moment to bind before the first real request.
    for (let i = 0; i < ONECLI_READY_PROBE_LIMIT; i++) {
      if (yield* isOnecliReachable()) {
        return;
      }
      yield* Effect.sleep(Duration.millis(ONECLI_READY_PROBE_INTERVAL_MS));
    }

    const probeWindowSeconds =
      (ONECLI_READY_PROBE_LIMIT * ONECLI_READY_PROBE_INTERVAL_MS) /
      MILLISECONDS_PER_SECOND;
    return yield* Effect.fail(
      toRuntimeError(
        `OneCLI gateway started but not reachable at ${ONECLI_URL} ` +
          `after ${probeWindowSeconds}s. ` +
          `Check: docker compose -p onecli -f ${ONECLI_COMPOSE_PATH} logs`,
      ),
    );
  });
}

// The container registers over HTTP before its client opens the socket. The
// address arrives path-free from `SpawnInput`, so only the scheme changes.
function nanoclawHttpServerUrl(serverUrl: string): string {
  return serverUrl.replace(/^ws/, "http");
}

// Runtime dirs are docker bind-mount sources (agent-runner src, group and
// session dirs), and macOS VM-backed engines only share paths under the
// user home by default — the system temp dir is invisible to containers —
// so per-agent dirs live under the testbed cache root instead.
const NANOCLAW_RUNTIME_DIR_ROOT = join(
  MOLTZAP_TESTBED_CACHE_ROOT,
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
        if (!(yield* fileSystem.exists(NANOCLAW_RUNTIME_DIR_ROOT))) return;
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
    Effect.provide(Path.layer),
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
    MOLTZAP_PROFILE: TESTBED_PROFILE_NAME,
    MOLTZAP_CONFIG_HOME: join(runtimeDir, ".moltzap"),
    MOLTZAP_SERVER_URL: nanoclawHttpServerUrl(opts.serverUrl),
    MOLTZAP_EVAL_MODE: opts.autoRegisterConversations ? "1" : "0",
    CONTAINER_RUNTIME: "docker",
    CONTAINER_IMAGE: install.containerImage,
    ONECLI_URL: ONECLI_URL,
    // The OneCLI SDK stages its gateway CA/credential bind-mount sources
    // under os.tmpdir(); pointing TMPDIR into the runtime dir keeps them
    // docker-shareable on macOS (the OS temp root is invisible to
    // VM-backed engines).
    TMPDIR: join(runtimeDir, "tmp"),
    LOG_LEVEL: "info",
  };
}

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
    env: buildNanoclawChildEnvironment(
      opts,
      runtimeDir,
      install,
      baseEnvironment,
    ),
  };
}

/** @internal */
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
    env: buildNanoclawChildEnvironment(
      opts,
      runtimeDir,
      install,
      baseEnvironment,
    ),
  };
}

function makeNanoclawCommand(
  opts: StartNanoclawRuntimeOptions,
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
) {
  return BaseChildEnvironmentConfig.pipe(
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
  if (!opts.autoRegisterConversations) return Effect.void;
  return BaseChildEnvironmentConfig.pipe(
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
    Effect.provide(NodeContext.layer),
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
    Effect.provide(Path.layer),
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
    Effect.provide(NodeContext.layer),
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
// budget — lives entirely in `waitUntilReady`, matching the OpenClaw
// adapter's semantics for the shared `Runtime` contract.
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

export function startNanoclawRuntimeEffect(
  opts: StartNanoclawRuntimeOptions,
  install: NanoclawRuntimeInstall,
): Effect.Effect<
  NanoclawRuntimeHandle,
  NanoclawRuntimeProcessError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* ensureOnecliRunning();
    yield* sweepStaleRuntimeDirs();
    const runtimeDir = yield* createNanoclawRuntimeDir();
    return yield* startConfiguredNanoclawRuntime(
      opts,
      runtimeDir,
      install,
    ).pipe(Effect.onError(() => removeNanoclawRuntimeDir(runtimeDir)));
  }).pipe(Effect.withSpan("startNanoclawRuntimeEffect"));
}

export function stopNanoclawRuntimeEffect(
  handle: NanoclawRuntimeHandle,
): Effect.Effect<void, NanoclawRuntimeProcessError, FileSystem.FileSystem> {
  return Effect.uninterruptible(
    stopNanoclawProcess(handle).pipe(
      Effect.ensuring(Scope.close(handle.scope, Exit.succeed(undefined))),
      Effect.ensuring(sweepNanoclawContainers(handle.runtimeDir)),
      Effect.ensuring(removeNanoclawRuntimeDir(handle.runtimeDir)),
    ),
  ).pipe(Effect.withSpan("stopNanoclawRuntimeEffect"));
}

/** @internal */
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

/** @internal */
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

/** @internal */
export function buildNanoclawContainerRemoveCommand(
  containerIds: ReadonlyArray<string>,
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

function sweepNanoclawContainers(runtimeDir: string) {
  return Effect.gen(function* () {
    const listResult = yield* runCommand(
      buildNanoclawContainerListCommand(runtimeDir),
      DOCKER_RUN_COMMAND_OPTIONS,
    );
    yield* requireSuccessfulCommand("list NanoClaw containers", listResult);
    const containerIds = listResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (containerIds.length === 0) return;

    const removeResult = yield* runCommand(
      buildNanoclawContainerRemoveCommand(containerIds),
      DOCKER_RUN_COMMAND_OPTIONS,
    );
    yield* requireSuccessfulCommand("remove NanoClaw containers", removeResult);
  }).pipe(
    Effect.provide(NodeContext.layer),
    Effect.catchAll((cause) =>
      Effect.logWarning("failed to sweep NanoClaw runtime containers", cause),
    ),
    Effect.withSpan("sweepNanoclawContainers"),
  );
}

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
