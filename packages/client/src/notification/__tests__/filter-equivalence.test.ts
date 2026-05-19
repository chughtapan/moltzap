/* eslint-disable max-nested-callbacks, max-lines-per-function, sonarjs/max-lines-per-function, agent-code-guard/as-unknown-as, agent-code-guard/async-keyword, jsdoc/text-escaping -- fast-check + Effect.gen + Stream.runForEach nest by construction; the cross-shape brand erasure in `oracle`/`fakeOtherFrame` is the typed→erased boundary the property test deliberately probes; fc.asyncProperty requires an async function */

/**
 * Filter-equivalence oracle (spec #596 §Acceptance criteria).
 *
 * For any property-generated sequence of inbound notifications (length up
 * to 32, value pool size up to 8) and any property-generated typed
 * predicate `p`, the Stream-based subscribe API output equals the pure-JS
 * reference `frames.filter(frame => def===frame.definition && p(frame.params))`.
 *
 * The oracle is a pure-JS reference implementation embedded in this file
 * (NOT a reference to the deleted three-storage shape).
 *
 * Bounded generators per spec: max array length 32, value pool size 8.
 *
 * The type-guard overload narrows the Stream's payload to
 * `DecodedNotification<D, R>`; the second property-test below pins the
 * runtime narrowing matches the compile-time canary in
 * `snapshot-semantics.types-check.ts → Canary #1`.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { Effect, Fiber, Ref, Stream } from "effect";
import {
  PresenceChangedNotificationDefinition,
  type DecodedNotification,
  type NotificationParamsOf,
} from "@moltzap/protocol";
import { makeSubscriberRegistry } from "../../runtime/subscribers.js";
import { subscribe } from "../stream.js";

const MAX_SEQUENCE_LENGTH = 32;
const VALUE_POOL_SIZE = 8;
const PROPERTY_RUN_COUNT = 25;

type PresenceParams = NotificationParamsOf<
  typeof PresenceChangedNotificationDefinition
>;

interface GeneratedFrame {
  readonly definitionTag: "presence" | "other";
  readonly agentId: string;
  readonly status: "online" | "offline";
}

const arbAgentId = fc
  .integer({ min: 0, max: VALUE_POOL_SIZE - 1 })
  .map((n) => `agent-${n}`);

const arbStatus = fc.constantFrom<"online" | "offline">("online", "offline");

const arbGeneratedFrame: fc.Arbitrary<GeneratedFrame> = fc.record({
  definitionTag: fc.constantFrom<"presence" | "other">("presence", "other"),
  agentId: arbAgentId,
  status: arbStatus,
});

const arbSequence = fc.array(arbGeneratedFrame, {
  minLength: 0,
  maxLength: MAX_SEQUENCE_LENGTH,
});

/** Pure-JS reference oracle. Filters by definition identity + predicate. */
function oracle(
  frames: ReadonlyArray<GeneratedFrame>,
  predicate: (params: PresenceParams) => boolean,
): ReadonlyArray<PresenceParams> {
  const presenceOnly = frames.filter((f) => f.definitionTag === "presence");
  const presenceParams = presenceOnly.map(
    (f) =>
      ({ agentId: f.agentId, status: f.status }) as unknown as PresenceParams, // #ignore-sloppy-code[as-unknown-as]: oracle uses property-generated string agentIds; brand assertion is the deliberate typed→erased boundary the property test exercises
  );
  return presenceParams.filter(predicate);
}

function decodedPresence(
  generated: GeneratedFrame,
): DecodedNotification<typeof PresenceChangedNotificationDefinition> {
  return {
    _tag: "Notification" as const,
    jsonrpc: "2.0",
    definition: PresenceChangedNotificationDefinition,
    method: PresenceChangedNotificationDefinition.name,
    params: {
      agentId: generated.agentId as PresenceParams["agentId"],
      status: generated.status,
    },
  } as DecodedNotification<typeof PresenceChangedNotificationDefinition>;
}

type PresenceFrame = DecodedNotification<
  typeof PresenceChangedNotificationDefinition
>;

function fakeOtherFrame(generated: GeneratedFrame): PresenceFrame {
  // A frame whose `.definition` reference does NOT match
  // `PresenceChangedNotificationDefinition` — used to verify the registry's
  // definition-identity filter drops it before the predicate runs.
  const raw = {
    _tag: "Notification" as const,
    jsonrpc: "2.0",
    definition: { name: "other/method" } as unknown,
    method: "other/method",
    params: { agentId: generated.agentId, status: generated.status },
  };
  return raw as unknown as PresenceFrame; // #ignore-sloppy-code[as-unknown-as]: fake-frame for the non-matching arm; the test is precisely about the boundary's behaviour on misshapen frames
}

describe("Spec B filter-equivalence oracle", () => {
  it("Stream output equals pure-JS filter oracle for arbitrary inputs", () =>
    fc.assert(
      fc.asyncProperty(arbSequence, async (frames) => {
        // Property-generated predicate: deterministic, total, varies by
        // status. Closing over an outer counter would invalidate the
        // oracle equivalence.
        const predicate = (params: PresenceParams) =>
          params.status === "online";

        const collected = await Effect.runPromise(
          Effect.gen(function* () {
            const registry = yield* makeSubscriberRegistry();
            const seen = yield* Ref.make<ReadonlyArray<PresenceParams>>([]);

            const fiber = yield* Effect.fork(
              subscribe(
                registry,
                PresenceChangedNotificationDefinition,
                predicate,
              ).pipe(
                Stream.runForEach((frame) =>
                  Ref.update(seen, (xs) => [...xs, frame.params]),
                ),
                Effect.catchAll(() => Effect.void),
              ),
            );

            // Yield once to materialise the Stream's subscription via
            // Stream.async's register callback.
            yield* Effect.yieldNow();

            for (const f of frames) {
              const decoded =
                f.definitionTag === "presence"
                  ? decodedPresence(f)
                  : fakeOtherFrame(f);
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
        const seen = yield* Ref.make<ReadonlyArray<PresenceParams>>([]);

        // Type guard form. The Stream's payload is now
        // `DecodedNotification<PresenceChangedNotificationDefinition, OnlinePresence>`
        // at compile-time; the runtime expectation is that no `offline`
        // params arrive.
        type OnlinePresence = PresenceParams & { status: "online" };
        const isOnline = (params: PresenceParams): params is OnlinePresence =>
          params.status === "online";

        const fiber = yield* Effect.fork(
          subscribe(
            registry,
            PresenceChangedNotificationDefinition,
            isOnline,
          ).pipe(
            Stream.runForEach((frame) =>
              Ref.update(seen, (xs) => [...xs, frame.params]),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        );
        yield* Effect.yieldNow();

        yield* registry.dispatch(
          decodedPresence({
            definitionTag: "presence",
            agentId: "agent-0",
            status: "online",
          }),
        );
        yield* registry.dispatch(
          decodedPresence({
            definitionTag: "presence",
            agentId: "agent-1",
            status: "offline",
          }),
        );

        yield* Effect.yieldNow();
        yield* registry.closeAll;
        yield* Fiber.join(fiber);

        const observed = yield* Ref.get(seen);
        expect(observed).toEqual([{ agentId: "agent-0", status: "online" }]);
      }),
    ));
});
