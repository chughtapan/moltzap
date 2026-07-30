/**
 * @file Shared async-wait primitives for tests. No wall-clock deadline — a
 * `Date.now()` bound false-times-out under parallel CPU load (worker and poller
 * starve together while the clock does not); the harness timeout is the only
 * bound. Polls on a real timer so it advances even under a `TestClock`.
 */
import { Effect } from "effect";

const DEFAULT_POLL_MILLIS = 5;

const realSleep = (millis: number): Effect.Effect<undefined> =>
  Effect.async<undefined>((resume) => {
    const timer = setTimeout(() => {
      resume(Effect.succeed(undefined));
    }, millis);
    return Effect.sync(() => {
      clearTimeout(timer);
    });
  });

/**
 * Poll `predicate` until it returns true.
 * @param predicate Predicate used to select matching values.
 * @param options Options that control the operation.
 * @param options.pollMillis Value supplied to the operation.
 * @returns The wait until result.
 */
export const waitUntil = (
  predicate: () => boolean,
  options?: { readonly pollMillis?: number },
): Effect.Effect<void> => {
  const interval = options?.pollMillis ?? DEFAULT_POLL_MILLIS;
  const step: Effect.Effect<void> = Effect.suspend(() =>
    predicate() ? Effect.void : Effect.flatMap(realSleep(interval), () => step),
  );
  return step;
};

/**
 * Poll `probe` until it returns a defined value, then return it.
 * @param probe Value supplied to the operation.
 * @param options Options that control the operation.
 * @param options.pollMillis Value supplied to the operation.
 * @returns The wait for value result.
 */
export const waitForValue = <A, E = never, R = never>(
  probe: Effect.Effect<A | undefined, E, R>,
  options?: { readonly pollMillis?: number },
): Effect.Effect<A, E, R> => {
  const interval = options?.pollMillis ?? DEFAULT_POLL_MILLIS;
  const step: Effect.Effect<A, E, R> = Effect.flatMap(probe, (value) =>
    value !== undefined
      ? Effect.succeed(value)
      : Effect.flatMap(realSleep(interval), () => step),
  );
  return step;
};
