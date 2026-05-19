/* eslint-disable max-nested-callbacks, max-lines-per-function, sonarjs/max-lines-per-function, agent-code-guard/no-example-only-tests -- vitest + Effect.gen + Stream.runForEach nest by construction; AD1 properties are scenario-shaped (snapshot semantics + lifecycle); generative coverage lives in filter-equivalence.test.ts */

/**
 * Snapshot-semantics property test (validates AD1 via spec #222 §5.3 OQ-3
 * acceptance criterion). Spec B (#596).
 *
 * Four architect-named properties (see `snapshot-semantics.types-check.ts`
 * for the compile-time AD1 canaries):
 *
 *   1. "No notification with arrival time > T_cancel is delivered through s."
 *      — verified via two subscriptions (`s_observer` + `s_target`) racing
 *      against a series of dispatched frames. After `s_target` cancels at
 *      frame index K, only `s_observer` keeps receiving frames K+1…N.
 *   2. "Unregister between frames doesn't affect prior dispatches." —
 *      verified by registering three subscribers, running `dispatch(frameN)`
 *      once; *after* the dispatch returns, interrupt `s2`, then
 *      `dispatch(frameN+1)` — assert s2 received frameN but not frameN+1.
 *      (Renamed in r1 cleanup per P2-3: this test does NOT exercise true
 *      mid-dispatch interleaving; the standalone "mid-dispatch" test below
 *      does.)
 *   3. "In-flight dispatch of frame N is NOT interrupted by an unregister
 *      that commits during frame N." — verified by forking a dispatch whose
 *      first invoked subscriber suspends on a `Deferred`. While the
 *      dispatch fiber is parked mid-handler, interrupt a SIBLING
 *      subscriber's consumer fiber (which calls `handle.unregister`
 *      via the Stream finalizer); release the dispatch fiber and assert
 *      the interrupted sibling STILL received the frame — proving the
 *      dispatch is iterating a snapshot, not the live list.
 *   4. "Closed client terminates all in-flight Streams with `NotConnectedError`."
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
 *
 * Determinism (r1 cleanup, P2-2): readiness between forked consumers and
 * the dispatch path uses `Effect.yieldNow()` (deterministic single-tick
 * scheduling) rather than `Effect.sleep(...)` (wall-clock dependent).
 * Mid-dispatch suspension uses `Deferred` so the dispatch fiber is parked
 * at a known point inside the handler, independent of any timer.
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

        // Yield once so each forked consumer's Stream.async register
        // callback commits its subscription into `subsRef` before the
        // dispatch loop reads the snapshot. `Effect.yieldNow()` is
        // deterministic (single-tick scheduling) — replaces the prior
        // `Effect.sleep("10 millis")` which was wall-clock dependent
        // (P2-2 r1 cleanup).
        yield* Effect.yieldNow();

        for (let i = 0; i < PROP_TEST_FRAME_COUNT; i++) {
          yield* registry.dispatch(decodedPresence(i));
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

        // Single-tick yield so every forked consumer's Stream.async
        // register callback commits before the first dispatch reads
        // the snapshot. Deterministic — see file header (P2-2 r1).
        yield* Effect.yieldNow();
        yield* registry.dispatch(decodedPresence(0));
        // Drain s2's onFrame Effect into receivedByS2 deterministically.
        yield* Effect.yieldNow();

        // Interrupt s2's consumer; Stream finalizer runs `unregister`
        // synchronously. Subsequent dispatch's snapshot must exclude s2.
        yield* Fiber.interrupt(s2Fiber);

        yield* registry.dispatch(decodedPresence(1));
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
        // (Stream-API end-to-end coverage is exercised by tests #1 and
        // the closeAll lifecycle test #4; here we need the registry's
        // direct API to control dispatch ordering deterministically.)
        const registry = yield* makeSubscriberRegistry();
        const enteredS1 = yield* Deferred.make<void>();
        const releaseS1 = yield* Deferred.make<void>();
        const s2Received = yield* Ref.make<ReadonlyArray<number>>([]);

        yield* registry.register(
          PresenceChangedNotificationDefinition,
          undefined,
          {
            onFrame: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(enteredS1, void 0);
                yield* Deferred.await(releaseS1);
              }),
            onClose: () => Effect.void,
          },
        );
        const s2Handle = yield* registry.register(
          PresenceChangedNotificationDefinition,
          undefined,
          {
            onFrame: (frame) =>
              Ref.update(s2Received, (xs) => [
                ...xs,
                Number(
                  (frame.params as { agentId: string }).agentId.slice(
                    "agent-".length,
                  ),
                ),
              ]),
            onClose: () => Effect.void,
          },
        );

        // Fork dispatch. Snapshot at fork time has both s1 and s2.
        const dispatchFiber = yield* Effect.fork(
          registry.dispatch(decodedPresence(0)),
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
        yield* registry.dispatch(decodedPresence(1));
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
        // before we call closeAll. P2-2 r1 cleanup.
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
        // register callback commits before dispatch reads the snapshot
        // (P2-2 r1).
        yield* Effect.yieldNow();
        yield* registry.dispatch(decodedPresence(0));
        yield* registry.dispatch(
          decodedMessageReceived() as DecodedNotification<AnyNotificationDefinition>,
        );

        // Drain the consumer's onFrame Effect into `observed` before
        // closing — deterministic single-tick.
        yield* Effect.yieldNow();
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
