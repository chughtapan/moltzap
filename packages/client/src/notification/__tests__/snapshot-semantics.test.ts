/* eslint-disable max-nested-callbacks, max-lines-per-function, sonarjs/max-lines-per-function, agent-code-guard/no-example-only-tests -- vitest + Effect.gen + Stream.runForEach nest by construction; these properties are scenario-shaped (snapshot semantics + lifecycle); generative coverage lives in filter-equivalence.test.ts */

/**
 * Snapshot-semantics property test for `subscribe` Stream cancellation.
 *
 * `SubscriberRegistry.dispatch` iterates a snapshot of the subscriber list,
 * so registrations and unregistrations that happen during a dispatch do not
 * change which subscribers receive that frame. These tests exercise the
 * registry through the public `notification/stream.ts` factories (not the
 * registry alone); the compile-time signature canaries live in
 * `subscribe-signatures.types-check.ts`.
 *
 *   1. No notification with arrival index > T_cancel is delivered through a
 *      cancelled subscription. Two subscriptions (`observer` + `target`)
 *      race a series of dispatched frames; after `target` cancels at frame
 *      index K, only `observer` keeps receiving frames K+1…N.
 *   2. Unregister between frames does not affect prior dispatches. Three
 *      subscribers run `dispatch(frameN)`; *after* it returns, `s2` is
 *      interrupted, then `dispatch(frameN+1)` runs — s2 received frameN but
 *      not frameN+1. (This case does not exercise mid-dispatch interleaving;
 *      the standalone mid-dispatch test below does.)
 *   3. An in-flight dispatch of frame N is NOT interrupted by an unregister
 *      that commits during frame N. A dispatch whose first subscriber
 *      suspends on a `Deferred` is forked; while it is parked mid-handler, a
 *      SIBLING subscriber's consumer fiber is interrupted (its Stream
 *      finalizer calls `handle.unregister`); after the dispatch fiber is
 *      released the interrupted sibling STILL received the frame — proof the
 *      dispatch iterates a snapshot, not the live list.
 *   4. A closed client terminates all in-flight Streams with
 *      `NotConnectedError`. A `Stream.runForEach` consumer is forked,
 *      `closeAll` runs, and the fiber's exit is a typed `NotConnectedError`.
 *
 * Each `expect` asserts a value computed by the system under test, never the
 * test's own input — no tautological "X === X" checks.
 *
 * Determinism: readiness between forked consumers and the dispatch path uses
 * `Effect.yieldNow()` (deterministic single-tick scheduling), not
 * `Effect.sleep(...)` (wall-clock dependent). Mid-dispatch suspension uses a
 * `Deferred` so the dispatch fiber parks at a known point in the handler,
 * independent of any timer.
 */
import { describe, expect, it } from "vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Stream,
} from "effect";
import {
  makeNotificationSubscriberRegistry,
  NotConnectedError,
} from "@moltzap/protocol/rpc";
import { MessageReceivedNotificationDefinition } from "@moltzap/protocol/message";
import { TaskFailedNotificationDefinition } from "@moltzap/protocol/task";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import type {
  NotificationDelivery,
  NotificationParamsOf,
} from "@moltzap/protocol/rpc";
import { buildMessage, testTaskId } from "../../test-utils/index.js";
import { subscribe, subscribeAll } from "../stream.js";

const PROP_TEST_FRAME_COUNT = 6;
const PROP_TEST_CANCEL_AT = 3;

type TaskFailedParams = NotificationParamsOf<
  typeof TaskFailedNotificationDefinition
>;

const taskIds = Array.from({ length: PROP_TEST_FRAME_COUNT }, (_, seq) =>
  testTaskId(`task-${seq}`),
);

const taskIndex = new Map(taskIds.map((taskId, seq) => [taskId, seq] as const));

function sequenceForTaskFailure(params: TaskFailedParams): number {
  return taskIndex.get(params.taskId) ?? Number.NaN;
}

const makeSubscriberRegistry = () =>
  makeNotificationSubscriberRegistry<
    NotConnectedError,
    AnyNotificationDefinition
  >({
    closeCause: () =>
      new NotConnectedError({ message: "WebSocket not connected" }),
  });

function taskFailedDelivery(
  seq: number,
): NotificationDelivery<typeof TaskFailedNotificationDefinition> {
  return {
    definition: TaskFailedNotificationDefinition,
    method: TaskFailedNotificationDefinition.name,
    params: {
      taskId: taskIds[seq] ?? testTaskId(`task-${seq}`),
      reason: seq % 2 === 0 ? "even" : "odd",
    },
  };
}

function messageReceivedDelivery(): NotificationDelivery<
  typeof MessageReceivedNotificationDefinition
> {
  return {
    definition: MessageReceivedNotificationDefinition,
    method: MessageReceivedNotificationDefinition.name,
    params: {
      taskId: testTaskId("task-1"),
      message: buildMessage({
        id: "m1",
        parts: [{ type: "text", text: "hi" }],
      }),
    },
  };
}

describe("subscribe snapshot semantics — Stream cancellation", () => {
  it("no notification with index > T_cancel is delivered through s_target", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeSubscriberRegistry();
        const observerSeen = yield* Ref.make<ReadonlyArray<number>>([]);
        const targetSeen = yield* Ref.make<ReadonlyArray<number>>([]);

        const observerFiber = yield* Effect.fork(
          subscribe(registry, TaskFailedNotificationDefinition).pipe(
            Stream.runForEach((params) =>
              Ref.update(observerSeen, (xs) => [
                ...xs,
                sequenceForTaskFailure(params),
              ]),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        );

        const targetStream = subscribe(
          registry,
          TaskFailedNotificationDefinition,
        );
        const targetFiber = yield* Effect.fork(
          targetStream.pipe(
            Stream.take(PROP_TEST_CANCEL_AT),
            Stream.runForEach((params) =>
              Ref.update(targetSeen, (xs) => [
                ...xs,
                sequenceForTaskFailure(params),
              ]),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        );

        // Yield once so each forked consumer's Stream.async register
        // callback commits its subscription into `subsRef` before the
        // dispatch loop reads the snapshot. `Effect.yieldNow()` is
        // deterministic (single-tick scheduling), not wall-clock dependent.
        yield* Effect.yieldNow();

        for (let i = 0; i < PROP_TEST_FRAME_COUNT; i++) {
          yield* registry.dispatch(taskFailedDelivery(i));
        }
        yield* Effect.yieldNow();

        yield* Fiber.join(targetFiber);

        // Drain the registry by running closeAll so the observer fiber
        // terminates with NotConnectedError and we can assert what it saw.
        yield* registry.closeAll;
        yield* Fiber.join(observerFiber);

        const target = yield* Ref.get(targetSeen);
        const observer = yield* Ref.get(observerSeen);

        // Target only saw the first PROP_TEST_CANCEL_AT frames before
        // Stream.take cancelled its subscription.
        expect(target.length).toBe(PROP_TEST_CANCEL_AT);
        for (const idx of target) {
          expect(idx).toBeLessThan(PROP_TEST_CANCEL_AT);
        }
        // Observer (never cancelled) saw every frame.
        expect(observer.length).toBe(PROP_TEST_FRAME_COUNT);
      }),
    ));

  it("unregister between frames doesn't affect prior dispatches", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // This test confirms a sequential property — dispatch frameN, then
        // interrupt s2 BETWEEN dispatches, then dispatch frameN+1 — and
        // observes that s2 received frameN (because it was registered) and
        // did NOT receive frameN+1 (because the snapshot at the start of
        // frameN+1's dispatch excludes the now-unregistered s2). Note that
        // there is NO concurrent interleaving here: every step completes
        // before the next begins. True mid-dispatch interleaving is
        // exercised by the "in-flight dispatch is NOT interrupted by an
        // unregister that commits during frame N" test below.
        const registry = yield* makeSubscriberRegistry();
        const receivedByS2 = yield* Ref.make<ReadonlyArray<number>>([]);

        const s1Fiber = yield* Effect.fork(
          subscribe(registry, TaskFailedNotificationDefinition).pipe(
            Stream.runDrain,
            Effect.catchAll(() => Effect.void),
          ),
        );
        const s3Fiber = yield* Effect.fork(
          subscribe(registry, TaskFailedNotificationDefinition).pipe(
            Stream.runDrain,
            Effect.catchAll(() => Effect.void),
          ),
        );

        const s2Stream = subscribe(registry, TaskFailedNotificationDefinition);
        const s2Fiber = yield* Effect.fork(
          s2Stream.pipe(
            Stream.runForEach((params) =>
              Ref.update(receivedByS2, (xs) => [
                ...xs,
                sequenceForTaskFailure(params),
              ]),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        );

        // Single-tick yield so every forked consumer's Stream.async
        // register callback commits before the first dispatch reads
        // the snapshot. Deterministic — see file header.
        yield* Effect.yieldNow();
        yield* registry.dispatch(taskFailedDelivery(0));
        // Drain s2's onFrame Effect into receivedByS2 deterministically.
        yield* Effect.yieldNow();

        // Interrupt s2's consumer; Stream finalizer runs `unregister`
        // synchronously. Subsequent dispatch's snapshot must exclude s2.
        yield* Fiber.interrupt(s2Fiber);

        yield* registry.dispatch(taskFailedDelivery(1));
        yield* Effect.yieldNow();

        const seen = yield* Ref.get(receivedByS2);
        expect(seen).toEqual([0]);

        // Tidy up sibling fibers.
        yield* registry.closeAll;
        yield* Fiber.join(s1Fiber);
        yield* Fiber.join(s3Fiber);
      }),
    ));

  it("in-flight dispatch is NOT interrupted by an unregister that commits during frame N", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // True mid-dispatch interleaving — distinguishes the snapshot
        // semantic from a live-list-iteration semantic (which would skip
        // the unregistered subscriber).
        //
        // Method: register two subscribers directly via the registry API
        // so we control the dispatch fiber's progress mid-handler. s1's
        // handler parks the dispatcher on a `Deferred` inside onFrame.
        // While parked, we call `s2.unregister` synchronously — mutating
        // `subsRef`. We then release s1; the dispatcher continues to s2
        // (per its captured snapshot) and invokes `s2.onFrame`. If the
        // dispatcher iterated the LIVE list, s2 would have been skipped
        // and `s2Received` would still be empty.
        //
        // Stream API tests cover end-to-end subscription behavior; this case
        // uses the registry directly to control dispatch ordering.
        const registry = yield* makeSubscriberRegistry();
        const enteredS1 = yield* Deferred.make<void>();
        const releaseS1 = yield* Deferred.make<void>();
        const s2Received = yield* Ref.make<ReadonlyArray<number>>([]);

        yield* registry.register(TaskFailedNotificationDefinition, undefined, {
          onFrame: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(enteredS1, void 0);
              yield* Deferred.await(releaseS1);
            }),
          onClose: () => Effect.void,
        });
        const s2Handle = yield* registry.register(
          TaskFailedNotificationDefinition,
          undefined,
          {
            onFrame: (params) =>
              Ref.update(s2Received, (xs) => [
                ...xs,
                sequenceForTaskFailure(params),
              ]),
            onClose: () => Effect.void,
          },
        );

        // Fork dispatch. Snapshot at fork time has both s1 and s2.
        const dispatchFiber = yield* Effect.fork(
          registry.dispatch(taskFailedDelivery(0)),
        );

        // Wait until s1's handler enters (dispatch is parked mid-flight).
        yield* Deferred.await(enteredS1);

        // Unregister s2 NOW — concurrently with the parked dispatch.
        // Mutates subsRef; in-flight snapshot is unaffected.
        yield* s2Handle.unregister;

        // Release s1; dispatch proceeds to s2 per its snapshot.
        yield* Deferred.succeed(releaseS1, void 0);
        yield* Fiber.join(dispatchFiber);

        const observed = yield* Ref.get(s2Received);
        // Snapshot semantic: s2 was in the snapshot, so its onFrame fires
        // even though it was unregistered while dispatch was mid-flight.
        expect(observed).toEqual([0]);

        // Sanity: confirm s2's unregister DID commit to subsRef — a
        // subsequent dispatch must NOT deliver to s2.
        yield* registry.dispatch(taskFailedDelivery(1));
        expect(yield* Ref.get(s2Received)).toEqual([0]);

        yield* registry.closeAll;
      }),
    ));

  it("closeAll terminates in-flight Streams with NotConnectedError", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeSubscriberRegistry();
        const fiber = yield* Effect.fork(
          subscribe(registry, MessageReceivedNotificationDefinition).pipe(
            Stream.runDrain,
            // Catch nothing — we want the fiber to exit with the failure
            // so we can pattern-match on it.
          ),
        );

        // Deterministic single-tick yield so the Stream materialises its
        // subscription (Stream.async register callback runs synchronously
        // inside Stream.runDrain's setup on the forked fiber's first turn)
        // before we call closeAll.
        yield* Effect.yieldNow();

        yield* registry.closeAll;

        const exit = yield* Fiber.await(fiber);
        const failure = Exit.causeOption(exit).pipe(
          Option.flatMap(Cause.failureOption),
        );
        // Verify the typed failure was NotConnectedError, not a defect.
        const ok = Option.match(failure, {
          onNone: () => false,
          onSome: (e) => e instanceof NotConnectedError,
        });
        expect(ok).toBe(true);
      }),
    ));

  it("subscribeAll receives every notification regardless of definition", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeSubscriberRegistry();
        const observed = yield* Ref.make<ReadonlyArray<string>>([]);

        const fiber = yield* Effect.fork(
          subscribeAll(registry).pipe(
            Stream.runForEach((frame) =>
              Ref.update(observed, (xs) => [
                ...xs,
                (frame.definition as AnyNotificationDefinition).name,
              ]),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        );

        // Single-tick yield ensures the forked subscribeAll consumer's
        // register callback commits before dispatch reads the snapshot.
        yield* Effect.yieldNow();
        yield* registry.dispatch(taskFailedDelivery(0));
        yield* registry.dispatch(messageReceivedDelivery());

        // Drain the consumer's onFrame Effect into `observed` before
        // closing — deterministic single-tick.
        yield* Effect.yieldNow();
        yield* registry.closeAll;
        yield* Fiber.join(fiber);

        const names = yield* Ref.get(observed);
        expect(names).toEqual([
          TaskFailedNotificationDefinition.name,
          MessageReceivedNotificationDefinition.name,
        ]);
      }),
    ));
});
