/** @file A storage fault the engine reports stops the daemon in storage. */

import { live as it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect } from "vitest";
import { makeFixture } from "../../__tests__/daemon-runtime-fixtures.js";
import {
  makeHarness,
  makeStore,
  run,
  type RuntimeHarness,
} from "../../__tests__/daemon-runtime-harness.js";
import { DaemonRuntimeError } from "../lifecycle.js";

describe("engine storage faults", () => {
  /**
   * The harness hands the test the report the daemon gave its engine, so the
   * test raises a storage fault the way a send's bind or proposal does. Fails
   * when the daemon keeps running after the report, or stops in another phase.
   */
  it("stops the daemon in storage when the engine reports a storage fault", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const original = yield* makeHarness(fixture, "none");
      const reported = yield* Deferred.make<Effect.Effect<void>>();
      const harness: RuntimeHarness = {
        ...original,
        dependencies: {
          ...original.dependencies,
          makeEngine: (input) =>
            Deferred.succeed(reported, input.reportStorageFault).pipe(
              Effect.zipRight(original.dependencies.makeEngine(input)),
            ),
        },
      };
      const daemon = yield* Effect.fork(
        run(fixture, makeStore(fixture, true, harness.delivery), harness),
      );
      yield* Deferred.await(harness.listenerReady);

      yield* Effect.flatten(Deferred.await(reported));

      expect(yield* Fiber.join(daemon).pipe(Effect.flip)).toEqual(
        new DaemonRuntimeError({ phase: "storage" }),
      );
    }));
});
