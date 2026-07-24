/**
 * Internal NanoClaw process helpers for the testbed runtime adapter.
 *
 * Installation and cache promotion live in `nanoclaw-install.ts`; this module
 * owns only isolated runtime directories and subprocess supervision.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  Command,
  FileSystem,
  HttpClient,
  HttpClientRequest,
  Path,
} from "@effect/platform";
import type { Process, Signal } from "@effect/platform/CommandExecutor";
import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import { Data, Duration, Effect, Exit, Fiber, Scope } from "effect";
import {
  resolveWorkspaceFileDestination,
  TESTBED_PROFILE_NAME,
  writeMoltZapProfileConfig,
} from "./channel-plugin-install.js";
import type { NanoclawRuntimeInstall } from "./nanoclaw-install.js";
import { consumeProcessStream, makeCommandHelpers } from "./child-process.js";

// OneCLI gateway — nanoclaw's container-runner calls this for per-container
// credential injection. Running locally from ~/.onecli/docker-compose.yml; the
// service answers both the dashboard and /api/container-config on this one
// port. Install: curl -fsSL https://onecli.sh/install | sh
const ONECLI_URL = "http://127.0.0.1:10254";
const ONECLI_COMPOSE_PATH = join(homedir(), ".onecli/docker-compose.yml");

// The bundled channel emits this local startup marker after its socket connects;
// the outer server-presence check remains the authoritative readiness gate.
const CONNECTED_MARKER = /MoltZap connected/;

const CONNECT_TIMEOUT_MS = 60_000;
// NanoClaw waits up to ten seconds for its queue to drain before disconnecting.
// Leave margin for channel disconnect and process exit before escalating.
const NANOCLAW_TERM_WAIT_MS = 12_000;
const NANOCLAW_KILL_WAIT_MS = 5_000;
const ONECLI_PROBE_TIMEOUT_MS = 2_000;
const ONECLI_READY_PROBE_LIMIT = 20;
const ONECLI_READY_PROBE_INTERVAL_MS = 500;
const CONNECT_WATCH_INTERVAL_MS = 200;
const LOG_TAIL_LINE_COUNT = 50;
const MILLISECONDS_PER_SECOND = 1_000;

export interface NanoclawRuntimeHandle {
  proc: Process;
  scope: Scope.CloseableScope;
  exitFiber: Fiber.RuntimeFiber<number, never>;
  runtimeDir: string;
  capturedLogs: string[];
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
}

function toRuntimeError(message: string, cause?: unknown) {
  return new NanoclawRuntimeProcessError({
    reason: message,
    ...(cause === undefined ? {} : { cause }),
  });
}

const { execEffect, fsEffect } = makeCommandHelpers(toRuntimeError);

// One resolved Path service for the sync helpers that pass it onward.
const PLATFORM_PATH = Effect.runSync(
  Path.Path.pipe(Effect.provide(Path.layer)),
);

function logTail(capturedLogs: readonly string[]): string {
  return capturedLogs
    .join("")
    .split("\n")
    .slice(-LOG_TAIL_LINE_COUNT)
    .join("\n");
}

function killProcessAndWait(
  proc: Process,
  signal: Signal,
  timeoutMs: number,
): Effect.Effect<boolean, never, never> {
  return proc.kill(signal).pipe(
    Effect.timeout(`${timeoutMs} millis`),
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  );
}

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

    yield* execEffect(
      `docker compose -p onecli -f "${ONECLI_COMPOSE_PATH}" up -d --wait`,
      { timeout: 120_000 },
    );

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

function normalizeNanoclawServerUrl(serverUrl: string): string {
  return serverUrl
    .replace(/\/ws$/, "")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:");
}

// Runtime dirs are docker bind-mount sources (agent-runner src, group and
// session dirs), and macOS VM-backed engines only share paths under the
// user home by default — the system temp dir is invisible to containers —
// so per-agent dirs live under the testbed cache root instead.
const NANOCLAW_RUNTIME_DIR_ROOT = join(
  homedir(),
  ".cache",
  "moltzap-testbed",
  "nanoclaw-runtimes",
);

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
  if (workspaceFiles === undefined) {
    return Effect.void;
  }
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      Effect.forEach(
        workspaceFiles,
        (file) => writeRuntimeWorkspaceFile(fileSystem, runtimeDir, file),
        { concurrency: 1, discard: true },
      ),
    ),
  );
}

function writeRuntimeWorkspaceFile(
  fileSystem: FileSystem.FileSystem,
  runtimeDir: string,
  file: NonNullable<StartNanoclawRuntimeOptions["workspaceFiles"]>[number],
) {
  const workspaceRoot = join(runtimeDir, "container/skills");
  const destination = resolveWorkspaceFileDestination(
    PLATFORM_PATH,
    workspaceRoot,
    file.relativePath,
  );
  if (destination === null) {
    return Effect.fail(
      toRuntimeError(
        `workspace path must stay below its agent root: ${file.relativePath}`,
      ),
    );
  }
  const destinationDir = dirname(destination);
  return Effect.all(
    [
      fsEffect(
        `create workspace file directory ${destinationDir}`,
        fileSystem.makeDirectory(destinationDir, { recursive: true }),
      ),
      fsEffect(
        `write workspace file ${destination}`,
        fileSystem.writeFileString(destination, file.content),
      ),
    ],
    { concurrency: 1, discard: true },
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
          ...["container", "scripts"].map((directory) =>
            fsEffect(
              `copy nanoclaw ${directory} into isolated runtime`,
              fileSystem.copy(
                join(install.cacheDir, directory),
                join(runtimeDir, directory),
                { overwrite: true },
              ),
            ),
          ),
          seedUpgradeMarker(fileSystem, runtimeDir, install),
          fsEffect(
            "create nanoclaw runtime temp directory",
            fileSystem.makeDirectory(join(runtimeDir, "tmp"), {
              recursive: true,
            }),
          ),
        ],
        { concurrency: 4, discard: true },
      ),
    ),
  );
}

// The runtime's cwd doubles as NanoClaw's PROJECT_ROOT: the startup
// tripwire reads ./package.json and data/upgrade-state.json from it and
// refuses to run unless the marker matches the code version, so a fresh
// runtime dir carries the manifest plus a matching sanctioned-upgrade
// marker.
function seedUpgradeMarker(
  fileSystem: FileSystem.FileSystem,
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
) {
  const manifestSource = join(install.cacheDir, "package.json");
  return Effect.gen(function* () {
    const manifest = yield* fsEffect(
      `read nanoclaw manifest ${manifestSource}`,
      fileSystem.readFileString(manifestSource, "utf8"),
    );
    const version = yield* Effect.try({
      try: () => (JSON.parse(manifest) as { version?: string }).version,
      catch: (cause) =>
        toRuntimeError(`unparsable nanoclaw manifest ${manifestSource}`, cause),
    });
    if (version === undefined) {
      return yield* Effect.fail(
        toRuntimeError(`nanoclaw manifest has no version: ${manifestSource}`),
      );
    }
    yield* fsEffect(
      "copy nanoclaw manifest into isolated runtime",
      fileSystem.copyFile(manifestSource, join(runtimeDir, "package.json")),
    );
    yield* fsEffect(
      "create nanoclaw data directory",
      fileSystem.makeDirectory(join(runtimeDir, "data"), { recursive: true }),
    );
    const marker = {
      version,
      updatedAt: new Date().toISOString(),
      via: "moltzap-testbed",
    };
    yield* fsEffect(
      "write nanoclaw upgrade marker",
      fileSystem.writeFileString(
        join(runtimeDir, "data", "upgrade-state.json"),
        JSON.stringify(marker, null, 2) + "\n",
      ),
    );
  });
}

export function buildNanoclawProcessPlan(
  opts: StartNanoclawRuntimeOptions,
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
): NanoclawProcessPlan {
  const entrypoint = join(install.cacheDir, "dist/index.js");
  return {
    command: "node",
    args: [entrypoint],
    cwd: runtimeDir,
    env: {
      MOLTZAP_PROFILE: TESTBED_PROFILE_NAME,
      MOLTZAP_CONFIG_HOME: join(runtimeDir, ".moltzap"),
      MOLTZAP_SERVER_URL: normalizeNanoclawServerUrl(opts.serverUrl),
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
    },
  };
}

function makeNanoclawCommand(
  opts: StartNanoclawRuntimeOptions,
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
) {
  const plan = buildNanoclawProcessPlan(opts, runtimeDir, install);
  return Command.make(plan.command, ...plan.args).pipe(
    Command.workingDirectory(plan.cwd),
    Command.env(plan.env),
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
  capturedLogs: string[],
) {
  const command = makeNanoclawCommand(opts, runtimeDir, install);
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      return yield* restore(
        initializeNanoclawProcess(command, scope, capturedLogs),
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
  command: ReturnType<typeof makeNanoclawCommand>,
  scope: Scope.CloseableScope,
  capturedLogs: string[],
) {
  return Effect.gen(function* () {
    const proc = yield* Command.start(command).pipe(Scope.extend(scope));
    const exitFiber = yield* proc.exitCode.pipe(
      Effect.map(Number),
      Effect.catchAll(() => Effect.succeed(-1)),
      Effect.forkIn(scope),
    );
    const appendLog = (chunk: string): void => {
      capturedLogs.push(chunk);
    };
    yield* consumeProcessStream(proc.stdout, appendLog).pipe(
      Effect.forkIn(scope),
    );
    yield* consumeProcessStream(proc.stderr, appendLog).pipe(
      Effect.forkIn(scope),
    );
    return { proc, scope, exitFiber } satisfies StartedNanoclawProcess;
  });
}

function waitForNanoclawConnection(
  exitFiber: Fiber.RuntimeFiber<number, never>,
  capturedLogs: string[],
) {
  return Effect.race(
    waitForConnectedMarker(capturedLogs),
    failIfProcessExitsBeforeConnect(exitFiber, capturedLogs),
  ).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(CONNECT_TIMEOUT_MS),
      onTimeout: () => connectionTimeoutError(capturedLogs),
    }),
  );
}

function waitForConnectedMarker(capturedLogs: string[]) {
  return Effect.iterate(false, {
    while: (connected) => !connected,
    body: () =>
      Effect.sleep(Duration.millis(CONNECT_WATCH_INTERVAL_MS)).pipe(
        Effect.as(CONNECTED_MARKER.test(capturedLogs.join(""))),
      ),
  }).pipe(Effect.asVoid);
}

function failIfProcessExitsBeforeConnect(
  exitFiber: Fiber.RuntimeFiber<number, never>,
  capturedLogs: string[],
) {
  return Fiber.join(exitFiber).pipe(
    Effect.flatMap((code) =>
      Effect.fail(
        toRuntimeError(
          `nanoclaw runtime exited before connecting (code=${code}).\nLast ${LOG_TAIL_LINE_COUNT} log lines:\n${logTail(capturedLogs)}`,
        ),
      ),
    ),
  );
}

function connectionTimeoutError(capturedLogs: string[]) {
  return toRuntimeError(
    `nanoclaw runtime did not connect within ${
      CONNECT_TIMEOUT_MS / MILLISECONDS_PER_SECOND
    }s.\nLast ${LOG_TAIL_LINE_COUNT} log lines:\n${logTail(capturedLogs)}`,
  );
}

function cleanupFailedNanoclawRuntime(handle: NanoclawRuntimeHandle) {
  return stopNanoclawRuntimeEffect(handle).pipe(
    Effect.catchAll((cause) =>
      Effect.logWarning(
        "failed to clean up NanoClaw after startup failure",
        cause,
      ),
    ),
  );
}

function startConfiguredNanoclawRuntime(
  opts: StartNanoclawRuntimeOptions,
  runtimeDir: string,
  install: NanoclawRuntimeInstall,
) {
  return Effect.gen(function* () {
    yield* seedNanoclawRuntimeDir(runtimeDir, install);
    yield* writeRuntimeWorkspaceFiles(runtimeDir, opts.workspaceFiles);
    yield* writeNanoclawMoltZapProfileConfig(opts, runtimeDir);

    const capturedLogs: string[] = [];
    const started = yield* startNanoclawProcess(
      opts,
      runtimeDir,
      install,
      capturedLogs,
    );
    const handle = { ...started, runtimeDir, capturedLogs };
    yield* waitForNanoclawConnection(started.exitFiber, capturedLogs).pipe(
      Effect.onError(() => cleanupFailedNanoclawRuntime(handle)),
    );
    return handle;
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
      Effect.ensuring(removeNanoclawRuntimeDir(handle.runtimeDir)),
    ),
  ).pipe(Effect.withSpan("stopNanoclawRuntimeEffect"));
}

function stopNanoclawProcess(handle: NanoclawRuntimeHandle) {
  return Effect.gen(function* () {
    if (!(yield* nanoclawProcessIsRunning(handle))) return;
    const exited = yield* killProcessAndWait(
      handle.proc,
      "SIGTERM",
      NANOCLAW_TERM_WAIT_MS,
    );
    if (!exited && (yield* nanoclawProcessIsRunning(handle))) {
      yield* killProcessAndWait(handle.proc, "SIGKILL", NANOCLAW_KILL_WAIT_MS);
    }
  });
}

function nanoclawProcessIsRunning(handle: NanoclawRuntimeHandle) {
  return handle.proc.isRunning.pipe(
    Effect.provide(NodeContext.layer),
    Effect.mapError((cause) =>
      toRuntimeError("check nanoclaw runtime process", cause),
    ),
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

export function getNanoclawRuntimeLogs(handle: NanoclawRuntimeHandle): string {
  return handle.capturedLogs.join("");
}
