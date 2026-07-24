import { Command } from "@effect/platform";
import type { Process, Signal } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { Duration, Effect, Fiber, Exit, Option, Scope, Stream } from "effect";

export interface CommandRunOptions {
  readonly cwd?: string;
  readonly timeout?: number;
}

type ErrorFactory<E> = (reason: string, cause?: unknown) => E;

function execEffectWith<E>(
  makeError: ErrorFactory<E>,
  commandText: string,
  options: CommandRunOptions,
): Effect.Effect<void, E> {
  const { cwd, timeout } = options;
  const command =
    cwd === undefined
      ? Command.make(commandText).pipe(Command.runInShell(true))
      : Command.make(commandText).pipe(
          Command.runInShell(true),
          Command.workingDirectory(cwd),
        );
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

/**
 * Shell-command and platform-error helpers shared by the runtime adapters.
 * Each module supplies its own tagged-error factory so failures stay in
 * that module's error channel.
 */
export function makeCommandHelpers<E>(makeError: ErrorFactory<E>) {
  return {
    execEffect: (commandText: string, options?: CommandRunOptions) =>
      execEffectWith(makeError, commandText, options ?? {}),
    fsEffect: <A>(reason: string, effect: Effect.Effect<A, PlatformError>) =>
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
    this.tail = (this.tail + rest).slice(-this.tailCapacity);
  }

  /**
   * Text from `offset` (original-stream position) to the current end;
   * regions no longer retained collapse into an elision marker.
   */
  read(offset: number): { readonly text: string; readonly nextOffset: number } {
    const tailStart = this.total - this.tail.length;
    if (offset >= tailStart) {
      return {
        text: this.tail.slice(this.tail.length - (this.total - offset)),
        nextOffset: this.total,
      };
    }
    const headPart = offset < this.head.length ? this.head.slice(offset) : "";
    const elided = tailStart > Math.max(offset, this.head.length);
    return {
      text: headPart + (elided ? LOG_ELISION_MARKER : "") + this.tail,
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
    return { proc, exitFiber };
  }).pipe(Effect.withSpan("startSupervisedProcess"));
}

const EXIT_POLL_INTERVAL_MS = 100;

/**
 * TERM→KILL escalation with bounded waits. Teardown runs in uninterruptible
 * regions, so each wait polls the exit fiber instead of racing the platform
 * `kill` await (which resolves only at process death and cannot be
 * interrupted there); the signals themselves are fired as daemons.
 */
export function escalatingKill(
  proc: Process,
  exitFiber: Fiber.RuntimeFiber<number, never>,
  waits: { readonly termWaitMs: number; readonly killWaitMs: number },
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    yield* sendSignal(proc, "SIGTERM");
    if (yield* exitedWithin(exitFiber, waits.termWaitMs)) return;
    yield* sendSignal(proc, "SIGKILL");
    yield* exitedWithin(exitFiber, waits.killWaitMs);
  }).pipe(Effect.withSpan("escalatingKill"));
}

function sendSignal(
  proc: Process,
  signal: Signal,
): Effect.Effect<void, never, never> {
  return Effect.forkDaemon(
    proc.kill(signal).pipe(Effect.catchAll(() => Effect.void)),
  ).pipe(Effect.asVoid);
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
