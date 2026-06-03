/* eslint-disable max-nested-callbacks, max-lines-per-function, sonarjs/max-lines-per-function, agent-code-guard/as-unknown-as, agent-code-guard/async-keyword, jsdoc/text-escaping -- fast-check + Effect.gen + Stream.runForEach nest by construction; the cross-shape brand erasure in `oracle`/`fakeOtherFrame` is the typed→erased boundary the property test deliberately probes; fc.asyncProperty requires an async function */

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

// Property-generated predicate pool: each entry is deterministic and
// total (no closure over external state — closing over an outer counter
// would invalidate the oracle equivalence). `fc.constantFrom` picks one
// per run so the property varies the filter across the status enum rather
// than pinning a single hardcoded predicate.
const predicatePool: ReadonlyArray<(params: PresenceParams) => boolean> = [
  (params) => params.status === "online",
  (params) => params.status === "offline",
  () => true,
  () => false,
];
const arbPredicate = fc.constantFrom(...predicatePool);

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
