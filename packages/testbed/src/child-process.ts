import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { execPath } from "node:process";
import { Command } from "@effect/platform";
import type { Process, Signal } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import {
  Config,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Scope,
  Stream,
} from "effect";

export interface CommandRunOptions {
  readonly cwd?: string;
  readonly timeout?: number;
}

export interface CapturedCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The only operator variables a runtime child inherits: PATH so the runtime
 * can find its tools, HOME so per-user state resolution works inside the
 * exact-environment replacement.
 */
export interface BaseChildEnvironment {
  readonly PATH: string;
  readonly HOME: string;
}

export const BaseChildEnvironmentConfig: Config.Config<BaseChildEnvironment> =
  Config.all({
    PATH: Config.string("PATH"),
    HOME: Config.string("HOME").pipe(Config.withDefault(homedir())),
  });

export interface ExactEnvironmentCommandOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cleanupTreeOnExit?: boolean;
}

type ErrorFactory<E> = (reason: string, cause?: unknown) => E;

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
 * Builds a command whose target receives exactly `env`. Effect's Node command
 * executor merges command variables over the operator environment, so a
 * trusted Node launcher starts the target with an explicit replacement. The
 * launcher and target share the detached group created by the executor, which
 * keeps tree-directed teardown semantics on every supported Node platform.
 * Long-lived runtimes opt into launcher-owned exit cleanup so the group
 * leader remains present until every residual descendant receives KILL.
 */
export function makeExactEnvironmentCommand(
  options: ExactEnvironmentCommandOptions,
): Command.Command {
  const payload = Buffer.from(JSON.stringify(options)).toString("base64url");
  return Command.make(execPath, "-e", EXACT_ENVIRONMENT_LAUNCHER, payload).pipe(
    Command.workingDirectory(options.cwd),
  );
}

function execEffectWith<E>(
  makeError: ErrorFactory<E>,
  commandText: string,
  options: CommandRunOptions,
): Effect.Effect<void, E> {
  const { cwd, timeout } = options;
  const command =
    cwd === undefined
      ? makeShellCommand(commandText)
      : makeShellCommandInDirectory(commandText, cwd);
  const exitCode = Command.exitCode(command).pipe(
    Effect.mapError((cause) =>
      makeError(`command failed: ${commandText}`, cause),
    ),
  );
  const boundedExitCode =
    timeout === undefined
      ? exitCode
      : exitCode.pipe(
          Effect.timeoutFail({
            duration: Duration.millis(timeout),
            onTimeout: () =>
              makeError(`command timed out after ${timeout}ms: ${commandText}`),
          }),
        );
  return boundedExitCode.pipe(
    Effect.flatMap((code) =>
      Number(code) === 0
        ? Effect.void
        : Effect.fail(
            makeError(`command failed with exit code ${code}: ${commandText}`),
          ),
    ),
    Effect.provide(NodeContext.layer),
  );
}

function makeShellCommand(commandText: string) {
  return Command.make(commandText).pipe(Command.runInShell(true));
}

function makeShellCommandInDirectory(commandText: string, cwd: string) {
  return Command.workingDirectory(makeShellCommand(commandText), cwd);
}

// Callers parse this output, so capture is faithful rather than windowed
// like BoundedLogBuffer: eliding the middle of a JSON document turns
// "output too large" into a misleading parse error. The cap still bounds a
// runaway child, but surfaces as its own actionable failure.
const MAX_CAPTURED_OUTPUT_CHARS = 8 * 1024 * 1024;

class CapturedOutputTooLarge extends Data.TaggedError(
  "CapturedOutputTooLarge",
)<{
  readonly limit: number;
}> {
  override get message(): string {
    return `command produced more than ${String(this.limit)} characters of output`;
  }
}

function captureCommandStream(stream: Stream.Stream<Uint8Array, unknown>) {
  const chunks: string[] = [];
  let total = 0;
  return stream.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => {
      total += chunk.length;
      if (total > MAX_CAPTURED_OUTPUT_CHARS) {
        return Effect.fail(
          new CapturedOutputTooLarge({ limit: MAX_CAPTURED_OUTPUT_CHARS }),
        );
      }
      chunks.push(chunk);
      return Effect.void;
    }),
    Effect.map(() => chunks.join("")),
  );
}

function captureCommandOutput(command: Command.Command) {
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
      return { stdout, stderr, exitCode: Number(exitCode) };
    }),
  );
}

function commandFailureReason(
  description: string,
  output: CapturedCommandOutput,
  exitCode: number,
): string {
  const diagnostics = (output.stderr.trim() || output.stdout.trim()).slice(
    -LOG_TAIL_CAPACITY,
  );
  return (
    `command failed with exit code ${exitCode}: ${description}` +
    (diagnostics ? `\n${diagnostics}` : "")
  );
}

function commandOutputEffectWith<E>(
  makeError: ErrorFactory<E>,
  description: string,
  command: Command.Command,
  timeout: number,
): Effect.Effect<CapturedCommandOutput, E> {
  const captured = captureCommandOutput(command).pipe(
    Effect.mapError((cause) =>
      makeError(`command failed: ${description}`, cause),
    ),
  );
  return captured.pipe(
    Effect.timeoutFail({
      duration: Duration.millis(timeout),
      onTimeout: () =>
        makeError(`command timed out after ${timeout}ms: ${description}`),
    }),
    Effect.flatMap(({ exitCode, ...output }) =>
      exitCode === 0
        ? Effect.succeed(output)
        : Effect.fail(
            makeError(commandFailureReason(description, output, exitCode)),
          ),
    ),
    Effect.provide(NodeContext.layer),
  );
}

function unboundedCommandOutputEffectWith<E>(
  makeError: ErrorFactory<E>,
  description: string,
  command: Command.Command,
): Effect.Effect<CapturedCommandOutput, E> {
  return captureCommandOutput(command).pipe(
    Effect.mapError((cause) =>
      makeError(`command failed: ${description}`, cause),
    ),
    Effect.flatMap(({ exitCode, ...output }) =>
      exitCode === 0
        ? Effect.succeed(output)
        : Effect.fail(
            makeError(commandFailureReason(description, output, exitCode)),
          ),
    ),
    Effect.provide(NodeContext.layer),
  );
}

/**
 * Shell-command and platform-error helpers shared by the runtime adapters.
 * Each module supplies its own tagged-error factory so failures stay in
 * that module's error channel.
 */
export function makeCommandHelpers<E>(makeError: ErrorFactory<E>) {
  return {
    execEffect: (commandText: string, options?: CommandRunOptions) =>
      execEffectWith(makeError, commandText, options ?? {}),
    commandOutputEffect: (
      description: string,
      command: Command.Command,
      options?: Pick<CommandRunOptions, "timeout">,
    ) => {
      const timeout = options?.timeout;
      return timeout === undefined
        ? unboundedCommandOutputEffectWith(makeError, description, command)
        : commandOutputEffectWith(makeError, description, command, timeout);
    },
    fsEffect: <A, R>(
      reason: string,
      effect: Effect.Effect<A, PlatformError, R>,
    ): Effect.Effect<A, E, R> =>
      effect.pipe(Effect.mapError((cause) => makeError(reason, cause))),
  };
}

const UTF8_DECODER = new TextDecoder("utf-8");

const LOG_HEAD_CAPACITY = 64 * 1024;
const LOG_TAIL_CAPACITY = 256 * 1024;
const LOG_ELISION_MARKER = "\n[... log window elided ...]\n";

/**
 * Append-only process log window: the first `headCapacity` chars (startup
 * diagnostics) plus a rolling tail, so a chatty long-lived agent cannot
 * grow memory unbounded. Offsets are positions in the ORIGINAL stream —
 * pollers keep monotonic cursors even after the middle is elided.
 */
export class BoundedLogBuffer {
  private head = "";
  private tail = "";
  private total = 0;

  constructor(
    private readonly headCapacity = LOG_HEAD_CAPACITY,
    private readonly tailCapacity = LOG_TAIL_CAPACITY,
  ) {}

  append(chunk: string): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.head.length < this.headCapacity) {
      const take = Math.min(this.headCapacity - this.head.length, rest.length);
      this.head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (rest.length === 0) return;
    // Compact only past 2x capacity: V8 rope concatenation keeps `+=` cheap,
    // so the flatten amortizes to O(1)/char at a 2x memory high-water mark.
    this.tail += rest;
    if (this.tail.length >= 2 * this.tailCapacity) {
      this.tail = this.tail.slice(-this.tailCapacity);
    }
  }

  /**
   * Text from `offset` (original-stream position) to the current end;
   * regions no longer retained collapse into an elision marker.
   */
  read(offset: number): { readonly text: string; readonly nextOffset: number } {
    const tailStart = this.total - this.tail.length;
    if (offset >= tailStart) {
      return {
        text: this.tail.slice(offset - tailStart),
        nextOffset: this.total,
      };
    }
    const elided = tailStart > this.head.length;
    return {
      text:
        this.head.slice(offset) +
        (elided ? LOG_ELISION_MARKER : "") +
        this.tail,
      nextOffset: this.total,
    };
  }

  /** The full retained window (head + elision marker + tail). */
  get text(): string {
    return this.read(0).text;
  }
}

/** Drains a child stdout/stderr stream into the caller's log accumulator. */
function consumeProcessStream(
  stream: Stream.Stream<Uint8Array, unknown>,
  append: (chunk: string) => void,
): Effect.Effect<void, never, never> {
  return Stream.runForEach(stream, (chunk) =>
    Effect.sync(() => {
      append(UTF8_DECODER.decode(chunk));
    }),
  ).pipe(Effect.catchAll(() => Effect.void));
}

/**
 * Starts a command under `scope`, forks its exit fiber (the exit code, or
 * `-1` when the wait itself fails), and drains stdout/stderr into
 * `appendLog`.
 */
export function startSupervisedProcess(
  command: Command.Command,
  scope: Scope.CloseableScope,
  appendLog: (chunk: string) => void,
  processTreeCleanup: ProcessTreeCleanup = { claimed: false },
) {
  return Effect.gen(function* () {
    const proc = yield* Command.start(command).pipe(Scope.extend(scope));
    const exitFiber = yield* proc.exitCode.pipe(
      Effect.map(Number),
      Effect.catchAll(() => Effect.succeed(-1)),
      Effect.forkIn(scope),
    );
    yield* consumeProcessStream(proc.stdout, appendLog).pipe(
      Effect.forkIn(scope),
    );
    yield* consumeProcessStream(proc.stderr, appendLog).pipe(
      Effect.forkIn(scope),
    );
    if (!processTreeCleanup.launcherOwnsExitCleanup) {
      yield* Fiber.join(exitFiber).pipe(
        Effect.zipRight(dispatchProcessTreeKill(proc, processTreeCleanup)),
        Effect.forkDaemon,
      );
    }
    return { proc, exitFiber, processTreeCleanup };
  }).pipe(Effect.withSpan("startSupervisedProcess"));
}

const EXIT_POLL_INTERVAL_MS = 100;

export interface ProcessTreeCleanup {
  claimed: boolean;
  readonly launcherOwnsExitCleanup?: boolean;
}

/**
 * TERM→KILL escalation with bounded waits. Teardown runs in uninterruptible
 * regions, so each wait polls the exit fiber instead of racing the platform
 * `kill` await (which resolves only at process death and cannot be
 * interrupted there); the signals themselves are fired as daemons. The Node
 * executor starts a detached process group on POSIX and `Process.kill`
 * signals that group before falling back to the direct pid. On Windows the
 * same call uses `taskkill /T`, so both escalation stages include descendants.
 */
export function escalatingKill(
  proc: Process,
  exitFiber: Fiber.RuntimeFiber<number, never>,
  waits: { readonly termWaitMs: number; readonly killWaitMs: number },
  processTreeCleanup: ProcessTreeCleanup = { claimed: false },
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const initialExit = yield* pollFiberExitCode(exitFiber);
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
    yield* exitedWithin(exitFiber, waits.killWaitMs);
  }).pipe(Effect.withSpan("escalatingKill"));
}

function cleanupAfterLeaderExit(
  proc: Process,
  cleanup: ProcessTreeCleanup,
): Effect.Effect<void, never, never> {
  return cleanup.launcherOwnsExitCleanup
    ? Effect.void
    : dispatchProcessTreeKill(proc, cleanup);
}

function dispatchProcessTreeKill(
  proc: Process,
  cleanup: ProcessTreeCleanup,
): Effect.Effect<void, never, never> {
  return Effect.suspend(() => {
    if (cleanup.claimed) return Effect.void;
    cleanup.claimed = true;
    return sendSignal(proc, "SIGKILL");
  });
}

function sendSignal(
  proc: Process,
  signal: Signal,
): Effect.Effect<void, never, never> {
  return Effect.forkDaemon(
    proc.kill(signal).pipe(Effect.catchAll(() => Effect.void)),
  ).pipe(Effect.zipRight(Effect.yieldNow()), Effect.asVoid);
}

function exitedWithin(
  exitFiber: Fiber.RuntimeFiber<number, never>,
  waitMs: number,
): Effect.Effect<boolean, never, never> {
  return Effect.iterate(
    { elapsedMs: 0, exited: false },
    {
      while: (state) => !state.exited && state.elapsedMs < waitMs,
      body: (state) =>
        Effect.sleep(Duration.millis(EXIT_POLL_INTERVAL_MS)).pipe(
          Effect.zipRight(pollFiberExitCode(exitFiber)),
          Effect.map((exit) => ({
            elapsedMs: state.elapsedMs + EXIT_POLL_INTERVAL_MS,
            exited: Option.isSome(exit),
          })),
        ),
    },
  ).pipe(Effect.map((state) => state.exited));
}

/**
 * Polls a child exit fiber into an exit code: `none` while running, the
 * code once exited, `-1` if the fiber itself failed.
 */
export function pollFiberExitCode(
  exitFiber: Fiber.RuntimeFiber<number, never>,
): Effect.Effect<Option.Option<number>, never, never> {
  return Fiber.poll(exitFiber).pipe(
    Effect.map(
      Option.map((exit) =>
        Exit.match(exit, {
          onSuccess: (code) => code,
          onFailure: () => -1,
        }),
      ),
    ),
  );
}
