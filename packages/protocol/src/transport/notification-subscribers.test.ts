/**
 * @file Deterministic notification fan-out tests. Filling Stream.async's
 * default buffer makes backpressure observable without timers or scheduler
 * races: the next registry dispatch cannot complete until a pull frees space.
 */
import { Effect, Fiber, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { defineNotification } from "./definition.js";
import {
  makeNotificationSubscriberRegistry,
  notificationSubscribe,
  notificationSubscribeAll,
} from "./notification-subscribers.js";

const STREAM_ASYNC_BUFFER_CAPACITY = 16;
const BUFFERED_SEQUENCES = [...Array(STREAM_ASYNC_BUFFER_CAPACITY).keys()].map(
  (index) => index + 1,
);
const BLOCKED_SEQUENCE = STREAM_ASYNC_BUFFER_CAPACITY + 1;

const testNotification = defineNotification({
  name: "test/notification",
  params: Schema.Struct({ sequence: Schema.Number }),
});

const delivery = (sequence: number) => ({
  definition: testNotification,
  method: testNotification.name,
  params: { sequence },
});

function typedSubscriptionBackpressure(): Effect.Effect<void, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* makeNotificationSubscriberRegistry<
        string,
        typeof testNotification
      >({
        closeCause: () => "closed",
      });
      const registered = yield* Effect.makeLatch();
      const instrumented: typeof registry = {
        ...registry,
        register: (definition, callbacks, refinement) =>
          registry
            .register(definition, callbacks, refinement)
            .pipe(Effect.tap(() => registered.open)),
      };
      const pull = yield* notificationSubscribe(
        instrumented,
        testNotification,
      ).pipe(Stream.toPull);
      const firstPull = yield* pull.pipe(Effect.fork);
      yield* registered.await;
      yield* registry.dispatch(delivery(0));
      expect(Array.from(yield* Fiber.join(firstPull))).toEqual([
        { sequence: 0 },
      ]);

      yield* Effect.forEach(
        BUFFERED_SEQUENCES,
        (sequence) => registry.dispatch(delivery(sequence)),
        { concurrency: 1, discard: true },
      );
      const blocked = yield* registry
        .dispatch(delivery(BLOCKED_SEQUENCE))
        .pipe(Effect.fork);
      yield* Effect.yieldNow();
      expect(Option.isNone(yield* Fiber.poll(blocked))).toBe(true);

      const first = yield* pull;
      expect(Array.from(first)).toEqual([{ sequence: 1 }]);
      yield* Fiber.join(blocked);
    }),
  );
}

function broadSubscriptionBackpressure(): Effect.Effect<void, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* makeNotificationSubscriberRegistry<
        string,
        typeof testNotification
      >({
        closeCause: () => "closed",
      });
      const registered = yield* Effect.makeLatch();
      const instrumented: typeof registry = {
        ...registry,
        registerAll: (callbacks, refinement) =>
          registry
            .registerAll(callbacks, refinement)
            .pipe(Effect.tap(() => registered.open)),
      };
      const pull = yield* notificationSubscribeAll(instrumented).pipe(
        Stream.toPull,
      );
      const firstPull = yield* pull.pipe(Effect.fork);
      yield* registered.await;
      yield* registry.dispatch(delivery(0));
      expect(Array.from(yield* Fiber.join(firstPull))).toEqual([delivery(0)]);

      yield* Effect.forEach(
        BUFFERED_SEQUENCES,
        (sequence) => registry.dispatch(delivery(sequence)),
        { concurrency: 1, discard: true },
      );
      const blocked = yield* registry
        .dispatch(delivery(BLOCKED_SEQUENCE))
        .pipe(Effect.fork);
      yield* Effect.yieldNow();
      expect(Option.isNone(yield* Fiber.poll(blocked))).toBe(true);

      const first = yield* pull;
      expect(Array.from(first)).toEqual([delivery(1)]);
      yield* Fiber.join(blocked);
    }),
  );
}

// @agent-code-guard/regression-only: exact queue saturation is the invariant;
// generated payloads cannot make ignored emitter backpressure more observable.
describe("notification subscriber dispatch", () => {
  it("awaits typed Stream.async emitter offers", () =>
    Effect.runPromise(typedSubscriptionBackpressure()));

  it("awaits broad Stream.async emitter offers", () =>
    Effect.runPromise(broadSubscriptionBackpressure()));
});
