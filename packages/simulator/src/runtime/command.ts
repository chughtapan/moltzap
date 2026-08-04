/** @file Controller-owned production-router process supervision. */

import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { execPath } from "node:process";
import { Command } from "@effect/platform";
import type {
  ExitCode,
  Process,
  Signal,
} from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import { Config, Duration, Effect, Fiber, Option, Scope, Stream } from "effect";

/**
 * The only operator variables inherited by the controller-owned router.
 * PATH locates its installed entry point and HOME is replaced with run-owned
 * state before launch.
 */
export type BaseChildEnvironment = Readonly<Record<"PATH" | "HOME", string>>;

/** Provides the controller router's base child environment. */
export const baseChildEnvironmentConfig: Config.Config<BaseChildEnvironment> =
  Config.all({
    PATH: Config.string("PATH"),
    HOME: Config.string("HOME").pipe(Config.withDefault(homedir())),
  });

/** Exact environment and process-tree policy for the controller router. */
export interface ExactEnvironmentCommandOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cleanupTreeOnExit?: boolean;
}

const EXACT_ENVIRONMENT_LAUNCHER = `
const { spawn } = require("node:child_process");
const payload = JSON.parse(
  Buffer.from(process.argv[1], "base64url").toString("utf8"),
);
process.on("SIGTERM", () => {});
const cleanupTree = () => {
  if (process.platform === "win32") {
    const reaper = spawn(
      "taskkill",
      ["/pid", String(process.pid), "/T", "/F"],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    reaper.unref();
    setInterval(() => {}, 0x7fffffff);
    return;
  }
  process.kill(-process.pid, "SIGKILL");
};
const child = spawn(payload.command, payload.args, {
  cwd: payload.cwd,
  env: payload.env,
  stdio: "inherit",
  windowsHide: true,
});
child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.once("exit", (code) => {
  if (payload.cleanupTreeOnExit === true) {
    cleanupTree();
    return;
  }
  process.exit(code ?? 1);
});
`;

/**
 * Build a command whose target receives exactly the supplied environment.
 * The trusted Node launcher replaces the operator environment and preserves a
 * process-group leader until residual router descendants receive KILL.
 * @param options Router command and exact environment.
 * @returns The supervised platform command.
 */
export function makeExactEnvironmentCommand(
  options: ExactEnvironmentCommandOptions,
): Command.Command {
  const payload = Buffer.from(JSON.stringify(options)).toString("base64url");
  return Command.make(execPath, "-e", EXACT_ENVIRONMENT_LAUNCHER, payload).pipe(
    Command.workingDirectory(options.cwd),
  );
}

/**
 * Drain one router output stream into its caller-owned accumulator.
 * @param stream Child output bytes.
 * @param append Destination for decoded chunks.
 * @param processId Child process identity for diagnostics.
 * @param streamName Stream identity for diagnostics.
 * @returns Completion after the stream closes.
 */
function consumeProcessStream(
  stream: Stream.Stream<Uint8Array, unknown>,
  append: (chunk: string) => void,
  processId: Process["pid"],
  streamName: "stdout" | "stderr",
): Effect.Effect<void> {
  const decoder = new TextDecoder("utf-8");
  return Stream.runForEach(stream, (chunk) =>
    Effect.sync(() => {
      append(decoder.decode(chunk, { stream: true }));
    }),
  ).pipe(
    Effect.zipRight(
      Effect.sync(() => {
        const tail = decoder.decode();
        if (tail.length > 0) {
          append(tail);
        }
      }),
    ),
    Effect.catchAll((cause) =>
      Effect.logWarning("child process output stream failed").pipe(
        Effect.annotateLogs({ processId, streamName, cause }),
      ),
    ),
  );
}

/**
 * Start the controller router under a caller-owned scope.
 * @param command Exact router command.
 * @param scope Scope owning the process.
 * @param appendLog Destination for decoded process output.
 * @param processTreeCleanup Shared cleanup claim.
 * @returns Process, exit observation, and cleanup state.
 */
export const startSupervisedProcess = Effect.fn("startSupervisedProcess")(
  function* (
    command: Command.Command,
    scope: Scope.CloseableScope,
    appendLog: (chunk: string) => void,
    processTreeCleanup: ProcessTreeCleanup = { claimed: false },
  ) {
    const proc = yield* Command.start(command).pipe(Scope.extend(scope));
    const exitFiber = yield* proc.exitCode.pipe(Effect.forkIn(scope));
    yield* consumeProcessStream(
      proc.stdout,
      appendLog,
      proc.pid,
      "stdout",
    ).pipe(Effect.forkIn(scope));
    yield* consumeProcessStream(
      proc.stderr,
      appendLog,
      proc.pid,
      "stderr",
    ).pipe(Effect.forkIn(scope));
    if (!processTreeCleanup.launcherOwnsExitCleanup) {
      yield* Fiber.await(exitFiber).pipe(
        Effect.zipRight(dispatchProcessTreeKill(proc, processTreeCleanup)),
        Effect.forkDaemon,
      );
    }
    return { proc, exitFiber, processTreeCleanup };
  },
);

const EXIT_POLL_INTERVAL_MS = 100;

/** Mutable single-claim state shared by router cleanup paths. */
export interface ProcessTreeCleanup {
  claimed: boolean;
  readonly launcherOwnsExitCleanup?: boolean;
}

/**
 * Stop the controller router with bounded TERM then KILL waits.
 * @param proc Owned router process.
 * @param exitFiber Router exit observation.
 * @param waits Bounded graceful and forced-stop waits.
 * @param processTreeCleanup Shared cleanup claim.
 * @returns Completion after teardown is dispatched.
 */
export const escalatingKill = Effect.fn("escalatingKill")(function* (
  proc: Process,
  exitFiber: Fiber.RuntimeFiber<ExitCode, PlatformError>,
  waits: { readonly termWaitMs: number; readonly killWaitMs: number },
  processTreeCleanup: ProcessTreeCleanup = { claimed: false },
) {
  const initialExit = yield* Fiber.poll(exitFiber);
  if (Option.isSome(initialExit)) {
    yield* cleanupAfterLeaderExit(proc, processTreeCleanup);
    return;
  }
  yield* sendSignal(proc, "SIGTERM");
  const leaderExited = yield* exitedWithin(exitFiber, waits.termWaitMs);
  if (leaderExited) {
    yield* cleanupAfterLeaderExit(proc, processTreeCleanup);
    return;
  }
  yield* dispatchProcessTreeKill(proc, processTreeCleanup);
  const killed = yield* exitedWithin(exitFiber, waits.killWaitMs);
  if (!killed) {
    yield* Effect.logWarning(
      "child process remained alive after the SIGKILL wait",
    ).pipe(
      Effect.annotateLogs({
        processId: proc.pid,
        killWaitMs: waits.killWaitMs,
      }),
    );
  }
});

function cleanupAfterLeaderExit(
  proc: Process,
  cleanup: ProcessTreeCleanup,
): Effect.Effect<void> {
  return cleanup.launcherOwnsExitCleanup
    ? Effect.void
    : dispatchProcessTreeKill(proc, cleanup);
}

function dispatchProcessTreeKill(
  proc: Process,
  cleanup: ProcessTreeCleanup,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (cleanup.claimed) {
      return Effect.void;
    }
    cleanup.claimed = true;
    return sendSignal(proc, "SIGKILL");
  });
}

function sendSignal(proc: Process, signal: Signal): Effect.Effect<void> {
  return Effect.forkDaemon(
    proc
      .kill(signal)
      .pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning("child process signal failed").pipe(
            Effect.annotateLogs({ processId: proc.pid, signal, cause }),
          ),
        ),
      ),
  ).pipe(Effect.zipRight(Effect.yieldNow()), Effect.asVoid);
}

function exitedWithin(
  exitFiber: Fiber.RuntimeFiber<ExitCode, PlatformError>,
  waitMs: number,
): Effect.Effect<boolean> {
  return Effect.iterate(
    { elapsedMs: 0, exited: false },
    {
      while: (state) => !state.exited && state.elapsedMs < waitMs,
      body: (state) =>
        Effect.sleep(Duration.millis(EXIT_POLL_INTERVAL_MS)).pipe(
          Effect.zipRight(Fiber.poll(exitFiber)),
          Effect.map((exit) => ({
            elapsedMs: state.elapsedMs + EXIT_POLL_INTERVAL_MS,
            exited: Option.isSome(exit),
          })),
        ),
    },
  ).pipe(Effect.map((state) => state.exited));
}
