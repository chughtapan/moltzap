/** @file Runs Effect test traces under each test's abort signal. */

import type { TestContext, TestFunction } from "vitest";
import { Effect } from "effect";

/**
 * Run an Effect trace as a vitest test. Vitest aborts the test's signal when
 * the test times out, and the signal interrupts the trace's fiber, so a hung
 * trace stops at the timeout instead of running on in the worker and slowing
 * every later test there.
 * @param trace Builds the trace when the test starts.
 * @returns The test function to register.
 */
export function runTrace<A, E>(trace: () => Effect.Effect<A, E>): TestFunction {
  return ({ signal }) => Effect.runPromise(trace(), { signal });
}

/**
 * Run one Effect trace per case of `it.for`, each interrupted at its test's
 * timeout as `runTrace` describes.
 * @param trace Builds the trace for one case when its test starts.
 * @returns The `it.for` test function to register.
 */
export function runTraceFor<Case, A, E>(
  trace: (testCase: Case) => Effect.Effect<A, E>,
) {
  return (testCase: Case, { signal }: TestContext) =>
    Effect.runPromise(trace(testCase), { signal });
}
