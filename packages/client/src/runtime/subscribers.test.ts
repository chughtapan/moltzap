/**
 * Unit tests for the per-subscription event registry.
 *
 * Spec #222 §5.3 (C4 + the `RealClientEventSubscriber.subscribe` filter
 * stub) requires:
 *   - Every set filter field narrows delivery (AND semantics).
 *   - Subscriptions fire in registration order.
 *   - Unsubscribe-during-dispatch is next-frame effective (OQ-3 A
 *     snapshot semantics).
 *   - Handler exceptions are caught + logged, not propagated.
 *
 * Each scenario gets a dedicated test so a mutation that bypasses the
 * filter (e.g. force `matchesFilter` to always return `true`) trips the
 * filter-narrows tests but leaves order tests passing — the tests
 * discriminate.
 */
import * as fc from "fast-check";
import { expect, it } from "vitest";
import { Effect, Ref } from "effect";
import {
  ConversationArchivedNotificationDefinition,
  type AnyNotificationDefinition,
  type DecodedNotification,
  type NotificationParamsOf,
} from "@moltzap/protocol";
import {
  agentId,
  conversationId,
  taskId,
  TaskFailedNotificationDefinition,
} from "@moltzap/protocol/testing";
import { makeSubscriberRegistry, matchesFilter } from "./subscribers.js";

const TASK_ID = taskId("11111111-1111-4111-8111-111111111111");
const CONV_1 = conversationId("22222222-2222-4222-8222-222222222222");
const CONV_2 = conversationId("33333333-3333-4333-8333-333333333333");
const AGENT_ID = agentId("44444444-4444-4444-8444-444444444444");
const PROPERTY_RUNS = 25;
const SUBSCRIBER_DEFECT_MESSAGE = "subscriber blew up";
const CONSTRUCTION_THROW_MESSAGE = "construction-time throw";

function pushValue<A>(values: A[], value: A): Effect.Effect<void> {
  return Effect.sync(() => {
    values.push(value);
  });
}

function recordAndMaybeUnsubscribe(
  calls: number[],
  frameIdx: number,
  unsubscribe: Effect.Effect<void, never> | null,
) {
  return Effect.gen(function* () {
    calls.push(frameIdx);
    if (frameIdx === 0 && unsubscribe !== null) {
      yield* unsubscribe;
    }
  });
}

function subscriberDefect() {
  return Effect.die(new Error(SUBSCRIBER_DEFECT_MESSAGE));
}

function constructionThrow(): never {
  throw new Error(CONSTRUCTION_THROW_MESSAGE);
}

function increment(value: number): number {
  return value + 1;
}

const filterableNotification = (
  method: string,
  params: Record<string, unknown> | string,
): {
  readonly method: string;
  readonly params: Record<string, unknown> | string;
} => ({
  method,
  params,
});

const decodedNotification = <D extends AnyNotificationDefinition>(
  definition: D,
  params: NotificationParamsOf<D>,
): DecodedNotification<D> => {
  // Construct a DecodedNotification<D> directly from the typed
  // descriptor + params — bypassing the wire decoder is intentional
  // for test fixtures so the result type stays narrow to D rather than
  // collapsing to the group's union.
  const frame = definition.encode(params);
  return {
    _tag: "Notification" as const,
    jsonrpc: frame.jsonrpc,
    definition,
    method: definition.name,
    params,
  } as DecodedNotification<D>;
};

const taskFailedNotification = (): DecodedNotification<
  typeof TaskFailedNotificationDefinition
> =>
  decodedNotification(TaskFailedNotificationDefinition, {
    taskId: TASK_ID,
  });

const conversationArchivedNotification = (
  conv: typeof CONV_1,
): DecodedNotification<typeof ConversationArchivedNotificationDefinition> =>
  decodedNotification(ConversationArchivedNotificationDefinition, {
    conversationId: conv,
    archivedAt: "2026-05-03T00:00:00Z",
    by: AGENT_ID,
  });

it("property: notificationNamePrefix follows string startsWith", () => {
  expect.hasAssertions();
  fc.assert(
    fc.property(fc.string(), fc.string(), (method, prefix) => {
      expect(
        matchesFilter(
          { notificationNamePrefix: prefix },
          filterableNotification(method, {}),
        ),
      ).toBe(method.startsWith(prefix));
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

it("empty filter matches every frame", () => {
  expect(matchesFilter({}, filterableNotification("any", { x: 1 }))).toBe(true);
});

it("emissionTag matches on `__emissionTag` key", () => {
  const frame = filterableNotification("e", { __emissionTag: "tag-1" });
  expect(matchesFilter({ emissionTag: "tag-1" }, frame)).toBe(true);
  expect(matchesFilter({ emissionTag: "tag-other" }, frame)).toBe(false);
});

it("conversationId matches on `conversationId` key", () => {
  const frame = filterableNotification("e", { conversationId: "c-1" });
  expect(matchesFilter({ conversationId: "c-1" }, frame)).toBe(true);
  expect(matchesFilter({ conversationId: "c-2" }, frame)).toBe(false);
});

it("notificationNamePrefix uses startsWith", () => {
  const frame = filterableNotification("messages/received", {});
  expect(matchesFilter({ notificationNamePrefix: "messages/" }, frame)).toBe(
    true,
  );
  expect(matchesFilter({ notificationNamePrefix: "presence/" }, frame)).toBe(
    false,
  );
});

it("AND semantics: all set fields must match", () => {
  const frame = filterableNotification("messages/received", {
    __emissionTag: "tag-1",
    conversationId: "c-1",
  });
  expect(
    matchesFilter(
      {
        emissionTag: "tag-1",
        conversationId: "c-1",
        notificationNamePrefix: "m",
      },
      frame,
    ),
  ).toBe(true);
  expect(
    matchesFilter({ emissionTag: "tag-1", conversationId: "c-other" }, frame),
  ).toBe(false);
});

it("non-record `params` cannot satisfy payload-key filters", () => {
  const stringData = filterableNotification("e", "string-payload");
  expect(matchesFilter({ emissionTag: "x" }, stringData)).toBe(false);
  expect(matchesFilter({ conversationId: "x" }, stringData)).toBe(false);
  expect(matchesFilter({ notificationNamePrefix: "e" }, stringData)).toBe(true);
});

it("dispatches in registration order", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* makeSubscriberRegistry();
      const order: string[] = [];
      yield* registry.register({}, () => pushValue(order, "a"));
      yield* registry.register({}, () => pushValue(order, "b"));
      yield* registry.dispatch(taskFailedNotification());
      expect(order).toEqual(["a", "b"]);
    }),
  ));

it("unsubscribe stops delivery for the next frame", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* makeSubscriberRegistry();
      const aCalls: number[] = [];
      const bCalls: number[] = [];
      let frameIdx = 0;
      let unsubA: Effect.Effect<void, never> | null = null;

      const handleA = yield* registry.register({}, () =>
        recordAndMaybeUnsubscribe(aCalls, frameIdx, unsubA),
      );
      unsubA = handleA.unsubscribe;
      yield* registry.register({}, () => pushValue(bCalls, frameIdx));

      frameIdx = 0;
      yield* registry.dispatch(taskFailedNotification());
      frameIdx = 1;
      yield* registry.dispatch(taskFailedNotification());

      expect(aCalls).toEqual([0]); // a saw frame 0, not frame 1.
      expect(bCalls).toEqual([0, 1]); // b saw both — snapshot at start of frame 0 still included a; b is unaffected by a's unsub.
    }),
  ));

it("filters narrow delivery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* makeSubscriberRegistry();
      const seenByConv1: DecodedNotification<AnyNotificationDefinition>[] = [];
      const seenByConv2: DecodedNotification<AnyNotificationDefinition>[] = [];
      yield* registry.register({ conversationId: CONV_1 }, (frame) =>
        pushValue(seenByConv1, frame),
      );
      yield* registry.register({ conversationId: CONV_2 }, (frame) =>
        pushValue(seenByConv2, frame),
      );
      yield* registry.dispatch(conversationArchivedNotification(CONV_1));
      yield* registry.dispatch(conversationArchivedNotification(CONV_2));

      expect(seenByConv1).toHaveLength(1);
      expect(seenByConv2).toHaveLength(1);
      expect(
        (seenByConv1[0]!.params as { conversationId: string }).conversationId,
      ).toBe(CONV_1);
      expect(
        (seenByConv2[0]!.params as { conversationId: string }).conversationId,
      ).toBe(CONV_2);
    }),
  ));

it("handler exceptions are caught and subsequent subscribers still run", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* makeSubscriberRegistry();
      const otherCalls: number[] = [];

      yield* registry.register({}, subscriberDefect);
      yield* registry.register({}, () => pushValue(otherCalls, 1));

      yield* registry.dispatch(taskFailedNotification());

      expect(otherCalls).toEqual([1]); // other subscribers still fire.
    }),
  ));

it("construction-time handler throw is caught", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* makeSubscriberRegistry();
      const otherCalls: number[] = [];

      yield* registry.register({}, constructionThrow);
      yield* registry.register({}, () => pushValue(otherCalls, 1));

      yield* registry.dispatch(taskFailedNotification());

      expect(otherCalls).toEqual([1]); // subsequent subscribers still fire.
    }),
  ));

it("closeAll drops every subscription", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* makeSubscriberRegistry();
      const calls: number[] = [];
      yield* registry.register({}, () => pushValue(calls, 1));
      yield* registry.closeAll;
      yield* registry.dispatch(taskFailedNotification());
      expect(calls).toEqual([]);
    }),
  ));

it("Ref-make composition works inside an Effect.gen", () =>
  Effect.runPromise(
    // Smoke test that the Effect surface composes; the registry never
    // resolves with `never` failure tag, so this can't catch
    // typechecker drift, but it does pin behaviour.
    Effect.gen(function* () {
      const registry = yield* makeSubscriberRegistry();
      const counter = yield* Ref.make(0);
      yield* registry.register({}, () => Ref.update(counter, increment));
      yield* registry.dispatch(taskFailedNotification());
      const result = yield* Ref.get(counter);
      expect(result).toBe(1);
    }),
  ));
