/**
 * OneCLI gateway acquisition for NanoClaw runtimes.
 *
 * NanoClaw's container runner obtains per-container credentials from this
 * host-local gateway. The in-process permit suppresses duplicate startup
 * work in one simulator while the native file lock serializes independent
 * simulator processes.
 */
import { Buffer } from "node:buffer";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import {
  Command,
  FileSystem,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Data, Duration, Effect } from "effect";

export const ONECLI_GATEWAY_URL = "http://127.0.0.1:10254";

const ONECLI_COMPOSE_PATH = join(homedir(), ".onecli/docker-compose.yml");
const ONECLI_START_LOCK_PATH = join(
  homedir(),
  ".onecli/moltzap-simulator-start.lock",
);
const ONECLI_START_PERMIT = Effect.runSync(Effect.makeSemaphore(1));
const ONECLI_PROBE_TIMEOUT_MS = 2_000;
const ONECLI_READY_PROBE_LIMIT = 20;
const ONECLI_READY_PROBE_INTERVAL_MS = 500;
const ONECLI_COMPOSE_TIMEOUT_MS = 120_000;
const MILLISECONDS_PER_SECOND = 1_000;
const DOCKER_COMMAND = "docker";

export interface ExclusiveFileLockOptions {
  readonly path: string;
}

export interface ExclusiveFileLockCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
}

export interface ExclusiveFileLockProcessPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export class ExclusiveFileLockError extends Data.TaggedError(
  "ExclusiveFileLockError",
)<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.reason;
  }
}

const LOCK_SUPERVISOR_SCRIPT = `
const { spawn } = require("node:child_process");
const payload = JSON.parse(
  Buffer.from(process.argv[1], "base64url").toString("utf8"),
);
let child;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (child?.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch { // #ignore-sloppy-code[bare-catch]: group-kill ESRCH falls back to direct kill — the fallback is the handling
      child.kill("SIGKILL");
    }
  }
  process.exit(1);
};
process.stdin.resume();
process.stdin.once("end", stop);
process.stdin.once("close", stop);
process.on("SIGTERM", stop);
child = spawn(payload.command, payload.args, {
  cwd: payload.cwd,
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});
child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.once("exit", (code) => {
  process.exit(code ?? 1);
});
`;
const DARWIN_PLATFORM = "darwin";
const LINUX_PLATFORM = "linux";
const DARWIN_LOCK_COMMAND = "/usr/bin/lockf";
const DARWIN_KEEP_LOCK_FILE_FLAG = "-k";
const LINUX_LOCK_COMMAND = "flock";
const LINUX_EXCLUSIVE_FLAG = "-x";

function toLockError(reason: string, cause?: unknown) {
  return new ExclusiveFileLockError({
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Build the native lock-holder command for the current operating system. */
export function buildExclusiveFileLockProcessPlan(
  options: ExclusiveFileLockOptions,
  protectedCommand: ExclusiveFileLockCommand,
): Effect.Effect<ExclusiveFileLockProcessPlan, ExclusiveFileLockError> {
  const payload = Buffer.from(JSON.stringify(protectedCommand)).toString(
    "base64url",
  );
  const supervisorArgs = ["-e", LOCK_SUPERVISOR_SCRIPT, payload];
  switch (platform()) {
    case DARWIN_PLATFORM:
      return Effect.succeed({
        command: DARWIN_LOCK_COMMAND,
        args: [
          DARWIN_KEEP_LOCK_FILE_FLAG,
          options.path,
          execPath,
          ...supervisorArgs,
        ],
      });
    case LINUX_PLATFORM:
      return Effect.succeed({
        command: LINUX_LOCK_COMMAND,
        args: [LINUX_EXCLUSIVE_FLAG, options.path, execPath, ...supervisorArgs],
      });
    default:
      return Effect.fail(
        toLockError(
          `cross-process file locking is unsupported on ${platform()}`,
        ),
      );
  }
}

/** Run a command while the operating system holds an exclusive file lock. */
export function runCommandWithExclusiveFileLock(
  options: ExclusiveFileLockOptions,
  protectedCommand: ExclusiveFileLockCommand,
) {
  return buildExclusiveFileLockProcessPlan(options, protectedCommand).pipe(
    Effect.flatMap((plan) =>
      Command.make(plan.command, ...plan.args).pipe(
        Command.stdout("inherit"),
        Command.stderr("inherit"),
        Command.exitCode,
      ),
    ),
    Effect.mapError((cause) =>
      cause instanceof ExclusiveFileLockError
        ? cause
        : toLockError(`run command under lock ${options.path}`, cause),
    ),
    Effect.withSpan("runCommandWithExclusiveFileLock"),
  );
}

export interface OnecliGatewayErrorFactory<E> {
  (reason: string, cause?: unknown): E;
}

function isOnecliReachable(): Effect.Effect<
  boolean,
  never,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    // A failed status, including an unrelated process on the port, does not
    // satisfy the gateway readiness contract.
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    yield* client.execute(
      HttpClientRequest.get(`${ONECLI_GATEWAY_URL}/api/container-config`),
    );
    return true;
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(ONECLI_PROBE_TIMEOUT_MS),
      onTimeout: () => new Error("OneCLI reachability probe timed out"),
    }),
    Effect.catchAll((reachabilityError) =>
      reachabilityError instanceof Error &&
      reachabilityError.message.includes("timed out")
        ? Effect.succeed(false)
        : Effect.logWarning(
            "failed to probe OneCLI reachability",
            reachabilityError,
          ).pipe(Effect.as(false)),
    ),
  );
}

function runOnecliComposeUnderLock<E>(
  makeError: OnecliGatewayErrorFactory<E>,
): Effect.Effect<void, E, CommandExecutor> {
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
    Effect.mapError((cause) =>
      makeError("start OneCLI under the host lock", cause),
    ),
    Effect.timeoutFail({
      duration: Duration.millis(ONECLI_COMPOSE_TIMEOUT_MS),
      onTimeout: () => makeError("OneCLI compose startup timed out"),
    }),
    Effect.flatMap((composeExitCode) =>
      Number(composeExitCode) === 0
        ? Effect.void
        : Effect.fail(
            makeError(
              `OneCLI compose startup failed with exit code ${composeExitCode}`,
            ),
          ),
    ),
  );
}

function waitForOnecliReadiness<E>(
  makeError: OnecliGatewayErrorFactory<E>,
): Effect.Effect<void, E, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    // `--wait` observes compose healthchecks. The bounded HTTP probe also
    // waits for the gateway listener to accept real requests.
    for (let probe = 0; probe < ONECLI_READY_PROBE_LIMIT; probe++) {
      if (yield* isOnecliReachable()) return;
      yield* Effect.sleep(Duration.millis(ONECLI_READY_PROBE_INTERVAL_MS));
    }

    const probeWindowSeconds =
      (ONECLI_READY_PROBE_LIMIT * ONECLI_READY_PROBE_INTERVAL_MS) /
      MILLISECONDS_PER_SECOND;
    return yield* Effect.fail(
      makeError(
        `OneCLI gateway started but not reachable at ${ONECLI_GATEWAY_URL} ` +
          `after ${probeWindowSeconds}s. ` +
          `Check: docker compose -p onecli -f ${ONECLI_COMPOSE_PATH} logs`,
      ),
    );
  });
}

function startOnecliUnderLock<E>(
  makeError: OnecliGatewayErrorFactory<E>,
): Effect.Effect<void, E, CommandExecutor | HttpClient.HttpClient> {
  return Effect.gen(function* () {
    if (yield* isOnecliReachable()) return;
    yield* runOnecliComposeUnderLock(makeError);
    yield* waitForOnecliReadiness(makeError);
  });
}

export function ensureOnecliRunning<E>(
  makeError: OnecliGatewayErrorFactory<E>,
): Effect.Effect<
  void,
  E,
  CommandExecutor | FileSystem.FileSystem | HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    if (yield* isOnecliReachable()) return;

    const fileSystem = yield* FileSystem.FileSystem;
    const composeFileExists = yield* fileSystem
      .exists(ONECLI_COMPOSE_PATH)
      .pipe(
        Effect.mapError((cause) =>
          makeError(`check OneCLI compose file ${ONECLI_COMPOSE_PATH}`, cause),
        ),
      );
    if (!composeFileExists) {
      return yield* Effect.fail(
        makeError(
          `OneCLI gateway not running and not installed at ${ONECLI_COMPOSE_PATH}. ` +
            `Nanoclaw requires OneCLI to inject credentials into agent subcontainers. ` +
            `Install once with:\n\n  curl -fsSL https://onecli.sh/install | sh\n\n` +
            `Then open http://127.0.0.1:10254 and add your Anthropic credentials.`,
        ),
      );
    }

    yield* ONECLI_START_PERMIT.withPermits(1)(startOnecliUnderLock(makeError));
  }).pipe(Effect.withSpan("ensureOnecliRunning"));
}
