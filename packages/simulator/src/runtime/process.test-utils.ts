/** @file Test-clock control over the startup deadline runtimes arm. */

import { Chunk, Duration, Effect, TestClock } from "effect";

/**
 * Scheduler rounds a forked acquisition may take to arm its startup deadline.
 * Registration needs a handful; the bound exists so a runtime that arms no
 * deadline fails the calling test instead of parking on the test clock.
 */
const DEADLINE_ARMING_ROUNDS = 100;

/**
 * Yield until the test clock holds a wake-up at `deadline`.
 * @param deadline Clock instant the runtime under test is expected to wake on.
 * @returns Whether that wake-up is registered within the round bound.
 */
function awaitArmedDeadline(deadline: number): Effect.Effect<boolean> {
  return TestClock.sleeps().pipe(
    Effect.map((scheduled) =>
      Chunk.some(scheduled, (instant) => instant === deadline),
    ),
    Effect.zipLeft(Effect.yieldNow()),
    Effect.repeat({
      until: (armed: boolean) => armed,
      times: DEADLINE_ARMING_ROUNDS,
    }),
  );
}

/**
 * Expire the startup budget of a runtime acquisition running on another fiber.
 *
 * A runtime arms its startup deadline several fiber hops after its driver hands
 * back a session, so a fixture that has observed acquisition has not yet
 * observed the deadline. `TestClock.adjust` wakes only the sleepers already
 * registered when it runs and anchors a later registration to the clock it has
 * already advanced, which leaves the acquisition waiting on an instant that
 * never arrives. Waiting for the deadline itself to appear among the scheduled
 * wake-ups keeps fiber registration order out of the outcome.
 * @param within Startup budget the runtime under test was configured with.
 * @returns An effect that advances the test clock onto the armed deadline.
 */
export function expireStartupDeadline(
  within: Duration.Duration,
): Effect.Effect<void> {
  return TestClock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      awaitArmedDeadline(now + Duration.toMillis(within)),
    ),
    Effect.flatMap((armed) =>
      armed
        ? TestClock.adjust(within)
        : Effect.die(
            new Error(
              `runtime under test armed no startup deadline at ${Duration.format(within)}`,
            ),
          ),
    ),
  );
}
