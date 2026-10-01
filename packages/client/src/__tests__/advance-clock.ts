/** @file Steps the TestClock so fibers woken by each step can sleep again. */

import { Duration, Effect, TestClock } from "effect";

const STEP = Duration.millis(250);

/**
 * Advance the TestClock in 250 ms steps, yielding between them so every fiber
 * a step wakes registers its next sleep before the following step.
 * @param span Total virtual time to pass.
 * @returns Completion once the clock has moved by `span`.
 */
export function advanceClock(
  span: Duration.DurationInput,
): Effect.Effect<void> {
  const steps = Math.ceil(
    Duration.toMillis(Duration.decode(span)) / Duration.toMillis(STEP),
  );
  return Effect.forEach(
    Array.from({ length: steps }),
    () => TestClock.adjust(STEP).pipe(Effect.zipRight(Effect.yieldNow())),
    { concurrency: 1, discard: true },
  );
}
