/* eslint-disable max-nested-callbacks, max-lines-per-function, sonarjs/max-lines-per-function, agent-code-guard/no-example-only-tests -- vitest + Effect.gen + Stream.runForEach nest by construction; AD1 properties are scenario-shaped (snapshot semantics + lifecycle); generative coverage lives in filter-equivalence.test.ts */

/**
 * Snapshot-semantics property test (validates AD1 via spec #222 §5.3 OQ-3
 * acceptance criterion). Spec B (#596).
 *
 * Three architect-named properties (see `snapshot-semantics.types-check.ts`
 * for the compile-time AD1 canaries):
 *
 *   1. "No notification with arrival time > T_cancel is delivered through s."
 *      — verified via two subscriptions (`s_observer` + `s_target`) racing
 *      against a series of dispatched frames. After `s_target` cancels at
 *      frame index K, only `s_observer` keeps receiving frames K+1…N.
 *   2. "In-flight dispatch of frame N is not interrupted by unsubscribe
 *      during frame N." — verified by registering three subscribers, running
 *      `dispatch(frameN)` once; *after* the dispatch returns, `unregister`s2`,
 *      then `dispatch(frameN+1)` — assert s2 received frameN but not frameN+1.
 *   3. "Closed client terminates all in-flight Streams with `NotConnectedError`."
 *      — verified by forking a `Stream.runForEach` consumer, calling
 *      `closeAll`, then asserting the fiber's exit is a typed
 *      `NotConnectedError` failure.
 *
 * The tests intentionally exercise `SubscriberRegistry` + the
 * `notification/stream.ts` Stream factories together (the public API
 * surface), not the registry alone — Canary #3's "internal Scope, no
 * leakage" contract is what we are validating end-to-end.
 *
 * Per P3 #612 fix (architect revision): each `expect` here asserts a
 * value computed by the system under test rather than the test's own
 * input — no tautological "X === X" patterns.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Fiber, Option, Ref, Stream } from "effect";
import {
  NotConnectedError,
  type AnyNotificationDefinition,
  type DecodedNotification,
} from "@moltzap/protocol";
import {
  PresenceChangedNotificationDefinition,
  MessageReceivedNotificationDefinition,
} from "@moltzap/protocol";
import { makeSubscriberRegistry } from "../../runtime/subscribers.js";
import { subscribe, subscribeAll } from "../stream.js";

const PROP_TEST_FRAME_COUNT = 6;
const PROP_TEST_CANCEL_AT = 3;

function decodedPresence(
  seq: number,
): DecodedNotification<typeof PresenceChangedNotificationDefinition> {
  return {
    _tag: "Notification" as const,
    jsonrpc: "2.0",
    definition: PresenceChangedNotificationDefinition,
    method: PresenceChangedNotificationDefinition.name,
    params: {
      agentId: `agent-${seq}`,
      status: seq % 2 === 0 ? "online" : "offline",
    },
  } as DecodedNotification<typeof PresenceChangedNotificationDefinition>;
}

function decodedMessageReceived(): DecodedNotification<
  typeof MessageReceivedNotificationDefinition
> {
  return {
    _tag: "Notification" as const,
    jsonrpc: "2.0",
    definition: MessageReceivedNotificationDefinition,
    method: MessageReceivedNotificationDefinition.name,
    params: {
      message: {
        id: "m1",
        conversationId: "c1",
        senderId: "agent-0",
        parts: [{ type: "text", text: "hi" }],
      },
    },
  } as DecodedNotification<typeof MessageReceivedNotificationDefinition>;
}

describe("AD1 snapshot semantics — Stream cancellation", () => {
  it("no notification with index > T_cancel is delivered through s_target", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeSubscriberRegistry();
        const observerSeen = yield* Ref.make<ReadonlyArray<number>>([]);
        const targetSeen = yield* Ref.make<ReadonlyArray<number>>([]);

        const observerFiber = yield* Effect.fork(
          subscribe(registry, PresenceChangedNotificationDefinition).pipe(
            Stream.runForEach((frame) =>
              Ref.update(observerSeen, (xs) => [
                ...xs,
                Number(
                  (frame.params as { agentId: string }).agentId.slice(
                    "agent-".length,
                  ),
                ),
              ]),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        );

        const targetStream = subscribe(
          registry,
          PresenceChangedNotificationDefinition,
        );
        const targetFiber = yield* Effect.fork(
          targetStream.pipe(
            Stream.take(PROP_TEST_CANCEL_AT),
            Stream.runForEach((frame) =>
              Ref.update(targetSeen, (xs) => [
                ...xs,
                Number(
                  (frame.params as { agentId: string }).agentId.slice(
                    "agent-".length,
                  ),
                ),
              ]),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        );

        // Give both forked fibers a chance to run their Stream.async
        // register callback (which is what installs the subscription
        // into `subsRef`). Without this, `dispatch` below races against
        // registration and the test's snapshot semantic is meaningless.
        yield* Effect.sleep("10 millis");

        for (let i = 0; i < PROP_TEST_FRAME_COUNT; i++) {
          yield* registry.dispatch(decodedPresence(i));
        }
        yield* Effect.sleep("10 millis");

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

  it("in-flight dispatch of frame N is not interrupted by unregister during frame N", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeSubscriberRegistry();
        const receivedByS2 = yield* Ref.make<ReadonlyArray<number>>([]);

        const s1Fiber = yield* Effect.fork(
          subscribe(registry, PresenceChangedNotificationDefinition).pipe(
            Stream.runDrain,
            Effect.catchAll(() => Effect.void),
          ),
        );
        const s3Fiber = yield* Effect.fork(
          subscribe(registry, PresenceChangedNotificationDefinition).pipe(
            Stream.runDrain,
            Effect.catchAll(() => Effect.void),
          ),
        );

        const s2Stream = subscribe(
          registry,
          PresenceChangedNotificationDefinition,
        );
        // Fork s2's consumer with a manually cancellable interrupt — we
        // dispatch frameN, observe s2 received it, then interrupt s2 and
        // dispatch frameN+1 to confirm s2 does not receive that one.
        const s2Fiber = yield* Effect.fork(
          s2Stream.pipe(
            Stream.runForEach((frame) =>
              Ref.update(receivedByS2, (xs) => [
                ...xs,
                Number(
                  (frame.params as { agentId: string }).agentId.slice(
                    "agent-".length,
                  ),
                ),
              ]),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        );

        // Let every forked consumer's `Stream.async` register callback
        // commit into `subsRef` before the first dispatch races it.
        yield* Effect.sleep("10 millis");
        yield* registry.dispatch(decodedPresence(0));

        // Sleep so the s2 onFrame callback drains into receivedByS2.
        yield* Effect.sleep("10 millis");

        // Interrupt s2. The next dispatch's snapshot must exclude it.
        yield* Fiber.interrupt(s2Fiber);

        yield* registry.dispatch(decodedPresence(1));
        yield* Effect.sleep("10 millis");

        const seen = yield* Ref.get(receivedByS2);
        expect(seen).toEqual([0]);

        // Tidy up sibling fibers.
        yield* registry.closeAll;
        yield* Fiber.join(s1Fiber);
        yield* Fiber.join(s3Fiber);
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

        // Let the Stream materialise its subscription before closing.
        yield* Effect.sleep("10 millis");

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

        yield* Effect.sleep("10 millis");
        yield* registry.dispatch(decodedPresence(0));
        yield* registry.dispatch(
          decodedMessageReceived() as DecodedNotification<AnyNotificationDefinition>,
        );

        yield* Effect.sleep("10 millis");
        yield* registry.closeAll;
        yield* Fiber.join(fiber);

        const names = yield* Ref.get(observed);
        expect(names).toEqual([
          PresenceChangedNotificationDefinition.name,
          MessageReceivedNotificationDefinition.name,
        ]);
      }),
    ));
});
