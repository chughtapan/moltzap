/** @file Completion barrier shared by protocol activation and recovery. */

import { Deferred, Effect } from "effect";
import type { EngineRuntime } from "../engine-types.js";

const recoveryBarriers = new WeakMap<
  EngineRuntime,
  Deferred.Deferred<undefined>
>();

/**
 * Install the one completion barrier shared by all retries of a discontinuity.
 * @param runtime Engine entering Router recovery under its protocol gate.
 * @returns Completion after a barrier exists for the engine.
 */
export function installRecoveryBarrier(
  runtime: EngineRuntime,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (recoveryBarriers.has(runtime)) {
      return Effect.void;
    }
    return Deferred.make<undefined>().pipe(
      Effect.flatMap((barrier) =>
        Effect.sync(() => {
          if (!recoveryBarriers.has(runtime)) {
            recoveryBarriers.set(runtime, barrier);
          }
        }),
      ),
    );
  });
}

/**
 * Read the barrier that blocks new action activation during discontinuity.
 * @param runtime Engine whose recovery state guards action activation.
 * @returns The pending barrier, or absence while the Router is active.
 */
export function currentRecoveryBarrier(
  runtime: EngineRuntime,
): Deferred.Deferred<undefined> | undefined {
  return recoveryBarriers.get(runtime);
}

/**
 * Release the exact barrier after recovery has resumed every durable fold.
 * @param runtime Engine returning to normal protocol operation.
 * @param barrier Barrier captured by the completed recovery attempt.
 * @returns Completion after waiters resume and the barrier is removed.
 */
export function completeRecoveryBarrier(
  runtime: EngineRuntime,
  barrier: Deferred.Deferred<undefined>,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (recoveryBarriers.get(runtime) !== barrier) {
      return Effect.void;
    }
    return Deferred.succeed(barrier, undefined).pipe(
      Effect.asVoid,
      Effect.zipRight(
        Effect.sync(() => {
          if (recoveryBarriers.get(runtime) === barrier) {
            recoveryBarriers.delete(runtime);
          }
        }),
      ),
    );
  });
}
