import { it as effectIt } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  TestClock,
} from "effect";
import { expect } from "vitest";
import { withMoltzapdStartupDeadline } from "./moltzapd-child.js";

const it = effectIt.effect;
const TEST_DEADLINE = Duration.seconds(1);
const LOG_TAIL = "last child output";

function boundsAndInterruptsTheReadinessSequence() {
  return Effect.gen(function* () {
    const interrupted = yield* Deferred.make<undefined>();
    const readiness = Effect.never.pipe(
      Effect.ensuring(Deferred.succeed(interrupted, undefined)),
    );
    const running = yield* withMoltzapdStartupDeadline(
      readiness,
      () => LOG_TAIL,
      TEST_DEADLINE,
    ).pipe(Effect.exit, Effect.fork);

    yield* TestClock.adjust(TEST_DEADLINE);
    const exit = yield* Fiber.join(running);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(LOG_TAIL);
    }
    expect(yield* Deferred.isDone(interrupted)).toBe(true);
  });
}

it(
  "applies one interruptible deadline to the complete readiness sequence",
  boundsAndInterruptsTheReadinessSequence,
);
