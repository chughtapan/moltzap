/**
 * Internal NanoClaw process helpers for the testbed runtime adapter.
 *
 * Installation and cache promotion live in `nanoclaw-install.ts`; this module
 * owns only isolated runtime directories and subprocess supervision.
 */
import { homedir } from "node:os";
import { join } from "node:path";
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
import { Data, Duration, Effect, Exit, Fiber, Option, Scope } from "effect";
import {
  seedWorkspaceFiles,
  TESTBED_PROFILE_NAME,
  writeMoltZapProfileConfig,
} from "./channel-plugin-install.js";
import {
  MOLTZAP_TESTBED_CACHE_ROOT,
  type NanoclawRuntimeInstall,
} from "./nanoclaw-install.js";
import {
  BoundedLogBuffer,
  escalatingKill,
  makeCommandHelpers,
  startSupervisedProcess,
} from "./child-process.js";

// OneCLI gateway — nanoclaw's container-runner calls this for per-container
// credential injection. Running locally from ~/.onecli/docker-compose.yml; the
// service answers both the dashboard and /api/container-config on this one
// port. Install: curl -fsSL https://onecli.sh/install | sh
const ONECLI_URL = "http://127.0.0.1:10254";
const ONECLI_COMPOSE_PATH = join(homedir(), ".onecli/docker-compose.yml");

// NanoClaw waits up to ten seconds for its queue to drain before disconnecting.
// Leave margin for channel disconnect and process exit before escalating.
const NANOCLAW_TERM_WAIT_MS = 12_000;
const NANOCLAW_KILL_WAIT_MS = 5_000;
const ONECLI_PROBE_TIMEOUT_MS = 2_000;
const ONECLI_READY_PROBE_LIMIT = 20;
const ONECLI_READY_PROBE_INTERVAL_MS = 500;
const MILLISECONDS_PER_SECOND = 1_000;

export interface NanoclawRuntimeHandle {
  proc: Process;
  scope: Scope.CloseableScope;
  exitFiber: Fiber.RuntimeFiber<number, never>;
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
}

function toRuntimeError(message: string, cause?: unknown) {
  return new NanoclawRuntimeProcessError({
    reason: message,
    ...(cause === undefined ? {} : { cause }),
  });
}

const { execEffect, fsEffect } = makeCommandHelpers(toRuntimeError);

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
  logs: BoundedLogBuffer,
) {
  const command = makeNanoclawCommand(opts, runtimeDir, install);
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
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
  command: ReturnType<typeof makeNanoclawCommand>,
  scope: Scope.CloseableScope,
  logs: BoundedLogBuffer,
) {
  return startSupervisedProcess(command, scope, (chunk) => {
    logs.append(chunk);
  }).pipe(
    Effect.map(
      ({ proc, exitFiber }) =>
        ({ proc, scope, exitFiber }) satisfies StartedNanoclawProcess,
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
      Effect.ensuring(removeNanoclawRuntimeDir(handle.runtimeDir)),
    ),
  ).pipe(Effect.withSpan("stopNanoclawRuntimeEffect"));
}

function stopNanoclawProcess(handle: NanoclawRuntimeHandle) {
  return Effect.gen(function* () {
    if (!(yield* nanoclawProcessIsRunning(handle))) return;
    yield* escalatingKill(handle.proc, handle.exitFiber, {
      termWaitMs: NANOCLAW_TERM_WAIT_MS,
      killWaitMs: NANOCLAW_KILL_WAIT_MS,
    });
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
  return handle.logs.text;
}
