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
import { describe, expect, it, vi } from "vitest";
import { Effect, Ref } from "effect";
import type { EventFrame } from "@moltzap/protocol";
import { makeSubscriberRegistry, matchesFilter } from "./subscribers.js";

const eventFrame = (event: string, data: unknown): EventFrame => ({
  jsonrpc: "2.0",
  type: "event",
  event,
  data,
});

const noopLogger = { warn: vi.fn() };

describe("matchesFilter", () => {
  it("empty filter matches every frame", () => {
    expect(matchesFilter({}, eventFrame("any", { x: 1 }))).toBe(true);
  });

  it("emissionTag matches on `__emissionTag` key", () => {
    const frame = eventFrame("e", { __emissionTag: "tag-1" });
    expect(matchesFilter({ emissionTag: "tag-1" }, frame)).toBe(true);
    expect(matchesFilter({ emissionTag: "tag-other" }, frame)).toBe(false);
  });

  it("conversationId matches on `conversationId` key", () => {
    const frame = eventFrame("e", { conversationId: "c-1" });
    expect(matchesFilter({ conversationId: "c-1" }, frame)).toBe(true);
    expect(matchesFilter({ conversationId: "c-2" }, frame)).toBe(false);
  });

  it("eventNamePrefix uses startsWith", () => {
    const frame = eventFrame("messages/received", {});
    expect(matchesFilter({ eventNamePrefix: "messages/" }, frame)).toBe(true);
    expect(matchesFilter({ eventNamePrefix: "presence/" }, frame)).toBe(false);
  });

  it("AND semantics: all set fields must match", () => {
    const frame = eventFrame("messages/received", {
      __emissionTag: "tag-1",
      conversationId: "c-1",
    });
    expect(
      matchesFilter(
        { emissionTag: "tag-1", conversationId: "c-1", eventNamePrefix: "m" },
        frame,
      ),
    ).toBe(true);
    // conversationId mismatch → reject even when other fields match.
    expect(
      matchesFilter({ emissionTag: "tag-1", conversationId: "c-other" }, frame),
    ).toBe(false);
  });

  it("non-record `data` cannot satisfy payload-key filters", () => {
    const stringData = eventFrame("e", "string-payload");
    expect(matchesFilter({ emissionTag: "x" }, stringData)).toBe(false);
    expect(matchesFilter({ conversationId: "x" }, stringData)).toBe(false);
    // …but an event-name-prefix filter still applies.
    expect(matchesFilter({ eventNamePrefix: "e" }, stringData)).toBe(true);
  });
});

describe("SubscriberRegistry", () => {
  it("dispatches in registration order", async () => {
    const registry = await Effect.runPromise(
      makeSubscriberRegistry(noopLogger),
    );
    const order: string[] = [];
    await Effect.runPromise(
      registry.register({}, () => Effect.sync(() => void order.push("a"))),
    );
    await Effect.runPromise(
      registry.register({}, () => Effect.sync(() => void order.push("b"))),
    );
    await Effect.runPromise(registry.dispatch(eventFrame("e", {})));
    expect(order).toEqual(["a", "b"]);
  });

  it("unsubscribe stops delivery for the next frame (OQ-3 A snapshot)", async () => {
    const registry = await Effect.runPromise(
      makeSubscriberRegistry(noopLogger),
    );
    const aCalls: number[] = [];
    const bCalls: number[] = [];
    let frameIdx = 0;
    let unsubA: Effect.Effect<void, never> | null = null;

    const handleA = await Effect.runPromise(
      registry.register({}, () =>
        Effect.gen(function* () {
          aCalls.push(frameIdx);
          // During the FIRST frame's dispatch, a unsubscribes itself.
          // OQ-3 A: b should still see frame 0 (snapshot taken at
          // dispatch start), but a should NOT see frame 1.
          if (frameIdx === 0 && unsubA !== null) {
            yield* unsubA;
          }
        }),
      ),
    );
    unsubA = handleA.unsubscribe;
    await Effect.runPromise(
      registry.register({}, () =>
        Effect.sync(() => void bCalls.push(frameIdx)),
      ),
    );

    frameIdx = 0;
    await Effect.runPromise(registry.dispatch(eventFrame("e", {})));
    frameIdx = 1;
    await Effect.runPromise(registry.dispatch(eventFrame("e", {})));

    expect(aCalls).toEqual([0]); // a saw frame 0, not frame 1.
    expect(bCalls).toEqual([0, 1]); // b saw both — snapshot at start of frame 0 still included a; b is unaffected by a's unsub.
  });

  it("filters narrow delivery", async () => {
    const registry = await Effect.runPromise(
      makeSubscriberRegistry(noopLogger),
    );
    const seenByConv1: EventFrame[] = [];
    const seenByConv2: EventFrame[] = [];
    await Effect.runPromise(
      registry.register({ conversationId: "c-1" }, (frame) =>
        Effect.sync(() => void seenByConv1.push(frame)),
      ),
    );
    await Effect.runPromise(
      registry.register({ conversationId: "c-2" }, (frame) =>
        Effect.sync(() => void seenByConv2.push(frame)),
      ),
    );
    await Effect.runPromise(
      registry.dispatch(eventFrame("e", { conversationId: "c-1" })),
    );
    await Effect.runPromise(
      registry.dispatch(eventFrame("e", { conversationId: "c-2" })),
    );

    expect(seenByConv1).toHaveLength(1);
    expect(seenByConv2).toHaveLength(1);
    expect(
      (seenByConv1[0]!.data as { conversationId: string }).conversationId,
    ).toBe("c-1");
    expect(
      (seenByConv2[0]!.data as { conversationId: string }).conversationId,
    ).toBe("c-2");
  });

  it("handler exceptions are caught + logged via the injected logger", async () => {
    const warn = vi.fn();
    const registry = await Effect.runPromise(makeSubscriberRegistry({ warn }));
    const otherCalls: number[] = [];

    await Effect.runPromise(
      registry.register({}, () =>
        Effect.sync(() => {
          throw new Error("subscriber blew up");
        }),
      ),
    );
    await Effect.runPromise(
      registry.register({}, () => Effect.sync(() => void otherCalls.push(1))),
    );

    await Effect.runPromise(registry.dispatch(eventFrame("e", {})));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(otherCalls).toEqual([1]); // other subscribers still fire.
  });

  it("construction-time throw from handler is caught + logged (not escaped)", async () => {
    const warn = vi.fn();
    const registry = await Effect.runPromise(makeSubscriberRegistry({ warn }));
    const otherCalls: number[] = [];

    await Effect.runPromise(
      registry.register({}, (_frame) => {
        throw new Error("construction-time throw");
      }),
    );
    await Effect.runPromise(
      registry.register({}, () => Effect.sync(() => void otherCalls.push(1))),
    );

    await Effect.runPromise(registry.dispatch(eventFrame("e", {})));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(otherCalls).toEqual([1]); // subsequent subscribers still fire.
  });

  it("closeAll drops every subscription", async () => {
    const registry = await Effect.runPromise(
      makeSubscriberRegistry(noopLogger),
    );
    const calls: number[] = [];
    await Effect.runPromise(
      registry.register({}, () => Effect.sync(() => void calls.push(1))),
    );
    await Effect.runPromise(registry.closeAll);
    await Effect.runPromise(registry.dispatch(eventFrame("e", {})));
    expect(calls).toEqual([]);
  });

  it("Ref-make composition works: register inside an Effect.gen", async () => {
    // Smoke test that the Effect surface composes; the registry never
    // resolves with `never` failure tag, so this can't catch
    // typechecker drift, but it does pin behaviour.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeSubscriberRegistry(noopLogger);
        const counter = yield* Ref.make(0);
        yield* registry.register({}, () => Ref.update(counter, (n) => n + 1));
        yield* registry.dispatch(eventFrame("e", {}));
        return yield* Ref.get(counter);
      }),
    );
    expect(result).toBe(1);
  });
});
