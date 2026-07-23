import { Command } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { Duration, Effect, Fiber, Exit, Option, Stream } from "effect";

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

/** Drains a child stdout/stderr stream into the caller's log accumulator. */
export function consumeProcessStream(
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
