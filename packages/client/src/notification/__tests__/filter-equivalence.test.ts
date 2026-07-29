/* eslint-disable max-nested-callbacks, max-lines-per-function, sonarjs/max-lines-per-function, agent-code-guard/async-keyword, jsdoc/text-escaping -- fast-check + Effect.gen + Stream.runForEach nest by construction; fc.asyncProperty requires an async function */

/**
 * Property test: `subscribe`'s Stream output equals a pure-JS filter oracle.
 *
 * For any property-generated sequence of inbound notifications and any
 * property-generated typed predicate `p`, the Stream-based `subscribe`
 * output equals the pure-JS reference
 * `frames.filter(frame => def === frame.definition && p(frame.params))`.
 * The oracle is the embedded `oracle` function below; both consume the
 * same generated predicate so each run probes a different filter point.
 *
 * Generators are bounded so the property terminates: array length up to
 * `MAX_SEQUENCE_LENGTH`, agent-id pool up to `VALUE_POOL_SIZE`.
 *
 * The second test pins the runtime side of the type-guard overload: when
 * `subscribe` is called with a `params is R` guard, only matching params
 * reach the consumer. The compile-time counterpart lives in
 * `subscribe-signatures.types-check.ts`.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { Effect, Fiber, Ref, Stream } from "effect";
import {
  NotConnectedError,
  makeNotificationSubscriberRegistry,
} from "@moltzap/protocol/rpc";
import { messageReceivedNotificationDefinition } from "@moltzap/protocol/message";
import { taskFailedNotificationDefinition } from "@moltzap/protocol/task";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import type {
  NotificationDelivery,
  NotificationParamsOf,
} from "@moltzap/protocol/rpc";
import { subscribe } from "../stream.js";
import { buildMessage, testTaskId } from "../../test-utils/index.js";

const MAX_SEQUENCE_LENGTH = 32;
const VALUE_POOL_SIZE = 8;
const PROPERTY_RUN_COUNT = 25;

type TaskFailedParams = NotificationParamsOf<
  typeof taskFailedNotificationDefinition
>;

const makeSubscriberRegistry = () =>
  makeNotificationSubscriberRegistry<
    NotConnectedError,
    AnyNotificationDefinition
  >({
    closeCause: () =>
      new NotConnectedError({ message: "WebSocket not connected" }),
  });

interface GeneratedFrame {
  readonly definitionTag: "taskFailed" | "other";
  readonly taskId: TaskFailedParams["taskId"];
  readonly reason: "retryable" | "blocked";
}

const arbTaskId = fc
  .integer({ min: 0, max: VALUE_POOL_SIZE - 1 })
  .map((n) => testTaskId(`task-${n}`));

const arbReason = fc.constantFrom<"retryable" | "blocked">(
  "retryable",
  "blocked",
);

const arbGeneratedFrame: fc.Arbitrary<GeneratedFrame> = fc.record({
  definitionTag: fc.constantFrom<"taskFailed" | "other">("taskFailed", "other"),
  taskId: arbTaskId,
  reason: arbReason,
});

const arbSequence = fc.array(arbGeneratedFrame, {
  minLength: 0,
  maxLength: MAX_SEQUENCE_LENGTH,
});

// Property-generated predicate pool: each entry is deterministic and
// total (no closure over external state — closing over an outer counter
// would invalidate the oracle equivalence). `fc.constantFrom` picks one
// per run so the property varies the filter across the reason enum rather
// than pinning a single hardcoded predicate.
const predicatePool: ReadonlyArray<(params: TaskFailedParams) => boolean> = [
  (params) => params.reason === "retryable",
  (params) => params.reason === "blocked",
  () => true,
  () => false,
];
const arbPredicate = fc.constantFrom(...predicatePool);

/** Pure-JS reference oracle. Filters by definition identity + predicate. */
function oracle(
  frames: ReadonlyArray<GeneratedFrame>,
  predicate: (params: TaskFailedParams) => boolean,
): ReadonlyArray<TaskFailedParams> {
  const targetOnly = frames.filter((f) => f.definitionTag === "taskFailed");
  const targetParams = targetOnly.map((f) => ({
    taskId: f.taskId,
    reason: f.reason,
  }));
  return targetParams.filter(predicate);
}

function decodedTaskFailure(
  generated: GeneratedFrame,
): NotificationDelivery<typeof taskFailedNotificationDefinition> {
  return {
    definition: taskFailedNotificationDefinition,
    method: taskFailedNotificationDefinition.name,
    params: {
      taskId: generated.taskId,
      reason: generated.reason,
    },
  };
}

function otherFrame(): NotificationDelivery<
  typeof messageReceivedNotificationDefinition
> {
  // A frame whose `.definition` reference does NOT match
  // A frame with a different descriptor reference verifies that the registry's
  // definition-identity filter drops it before the predicate runs.
  return {
    definition: messageReceivedNotificationDefinition,
    method: messageReceivedNotificationDefinition.name,
    params: { taskId: testTaskId("task-1"), message: buildMessage() },
  };
}

describe("subscribe filter-equivalence oracle", () => {
  it("Stream output equals pure-JS filter oracle for arbitrary inputs", () =>
    fc.assert(
      fc.asyncProperty(arbSequence, arbPredicate, async (frames, predicate) => {
        // `predicate` is property-generated from `predicatePool`:
        // deterministic, total, varies by status across runs. The SAME
        // predicate value is fed to both `subscribe` and the oracle below,
        // so each run probes a different point in the filter space.
        const collected = await Effect.runPromise(
          Effect.gen(function* () {
            const registry = yield* makeSubscriberRegistry();
            const seen = yield* Ref.make<ReadonlyArray<TaskFailedParams>>([]);

            const fiber = yield* Effect.fork(
              subscribe(
                registry,
                taskFailedNotificationDefinition,
                predicate,
              ).pipe(
                Stream.runForEach((params) =>
                  Ref.update(seen, (xs) => [...xs, params]),
                ),
                Effect.catchAll(() => Effect.void),
              ),
            );

            // Yield once to materialise the Stream's subscription via
            // Stream.async's register callback.
            yield* Effect.yieldNow();

            for (const f of frames) {
              const decoded =
                f.definitionTag === "taskFailed"
                  ? decodedTaskFailure(f)
                  : otherFrame();
              yield* registry.dispatch(decoded);
            }

            yield* Effect.yieldNow();
            yield* registry.closeAll;
            yield* Fiber.join(fiber);

            return yield* Ref.get(seen);
          }),
        );

        const expected = oracle(frames, predicate);
        expect(collected).toEqual(expected);
      }),
      { numRuns: PROPERTY_RUN_COUNT },
    ));

  it("user-defined type guard narrows the Stream payload", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeSubscriberRegistry();
        const seen = yield* Ref.make<ReadonlyArray<TaskFailedParams>>([]);

        // Type guard form. The Stream's payload is now narrowed at compile-time;
        // the runtime expectation is that no non-matching params arrive.
        type RetryableTaskFailure = TaskFailedParams & {
          readonly reason: "retryable";
        };
        const isRetryable = (
          params: TaskFailedParams,
        ): params is RetryableTaskFailure => params.reason === "retryable";

        const fiber = yield* Effect.fork(
          subscribe(
            registry,
            taskFailedNotificationDefinition,
            isRetryable,
          ).pipe(
            Stream.runForEach((params) =>
              Ref.update(seen, (xs) => [...xs, params]),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        );
        yield* Effect.yieldNow();

        yield* registry.dispatch(
          decodedTaskFailure({
            definitionTag: "taskFailed",
            taskId: testTaskId("task-0"),
            reason: "retryable",
          }),
        );
        yield* registry.dispatch(
          decodedTaskFailure({
            definitionTag: "taskFailed",
            taskId: testTaskId("task-1"),
            reason: "blocked",
          }),
        );

        yield* Effect.yieldNow();
        yield* registry.closeAll;
        yield* Fiber.join(fiber);

        const observed = yield* Ref.get(seen);
        expect(observed).toEqual([
          { taskId: testTaskId("task-0"), reason: "retryable" },
        ]);
      }),
    ));
});
