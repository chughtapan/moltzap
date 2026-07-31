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
  type NotificationDelivery,
  type NotificationParamsOf,
} from "@moltzap/protocol/rpc";
import { messageReceivedNotificationDefinition } from "@moltzap/protocol/message";
import { dispatchRelease } from "@moltzap/protocol/message/dispatch";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import { subscribe } from "../stream.js";
import {
  buildMessage,
  testDispatchId,
  testLeaseId,
} from "../../test-utils/index.js";

const MAX_SEQUENCE_LENGTH = 32;
const VALUE_POOL_SIZE = 8;
const PROPERTY_RUN_COUNT = 25;

type ReleaseParams = NotificationParamsOf<typeof dispatchRelease>;

const makeSubscriberRegistry = () =>
  makeNotificationSubscriberRegistry<
    NotConnectedError,
    AnyNotificationDefinition
  >({
    closeCause: () =>
      new NotConnectedError({ message: "WebSocket not connected" }),
  });

interface GeneratedFrame {
  readonly definitionTag: "release" | "other";
  readonly leaseId: ReleaseParams["leaseId"];
  readonly decision: "deny" | "hold";
}

const arbLeaseId = fc
  .integer({ min: 0, max: VALUE_POOL_SIZE - 1 })
  .map((n) => testLeaseId(`lease-${n}`));

const arbDecision = fc.constantFrom<"deny" | "hold">("deny", "hold");

const arbGeneratedFrame: fc.Arbitrary<GeneratedFrame> = fc.record({
  definitionTag: fc.constantFrom<"release" | "other">("release", "other"),
  leaseId: arbLeaseId,
  decision: arbDecision,
});

const arbSequence = fc.array(arbGeneratedFrame, {
  minLength: 0,
  maxLength: MAX_SEQUENCE_LENGTH,
});

// Property-generated predicate pool: each entry is deterministic and
// total (no closure over external state — closing over an outer counter
// would invalidate the oracle equivalence). `fc.constantFrom` picks one
// per run so the property varies the filter across the verdict enum rather
// than pinning a single hardcoded predicate.
const predicatePool: ReadonlyArray<(params: ReleaseParams) => boolean> = [
  (params) => params.verdict.decision === "deny",
  (params) => params.verdict.decision === "hold",
  () => true,
  () => false,
];
const arbPredicate = fc.constantFrom(...predicatePool);

const DISPATCH_ID = testDispatchId("filter-equivalence");

function releaseParams(generated: GeneratedFrame): ReleaseParams {
  return {
    dispatchId: DISPATCH_ID,
    leaseId: generated.leaseId,
    verdict: { decision: generated.decision },
  };
}

/**
 * Pure-JS reference oracle. Filters by definition identity + predicate.
 * @param frames Value supplied to the operation.
 * @param predicate Predicate used to select matching values.
 * @returns The oracle result.
 */
function oracle(
  frames: readonly GeneratedFrame[],
  predicate: (params: ReleaseParams) => boolean,
): readonly ReleaseParams[] {
  return frames
    .filter((f) => f.definitionTag === "release")
    .map(releaseParams)
    .filter(predicate);
}

function decodedRelease(
  generated: GeneratedFrame,
): NotificationDelivery<typeof dispatchRelease> {
  return {
    definition: dispatchRelease,
    method: dispatchRelease.name,
    params: releaseParams(generated),
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
    params: { message: buildMessage() },
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
            const seen = yield* Ref.make<readonly ReleaseParams[]>([]);

            const fiber = yield* Effect.fork(
              subscribe(registry, dispatchRelease, predicate).pipe(
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
                f.definitionTag === "release"
                  ? decodedRelease(f)
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
        const seen = yield* Ref.make<readonly ReleaseParams[]>([]);

        // Type guard form. The Stream's payload is now narrowed at compile-time;
        // the runtime expectation is that no non-matching params arrive.
        type DeniedRelease = ReleaseParams & {
          readonly verdict: { readonly decision: "deny" };
        };
        const isDenied = (params: ReleaseParams): params is DeniedRelease =>
          params.verdict.decision === "deny";

        const fiber = yield* Effect.fork(
          subscribe(registry, dispatchRelease, isDenied).pipe(
            Stream.runForEach((params) =>
              Ref.update(seen, (xs) => [...xs, params]),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        );
        yield* Effect.yieldNow();

        const denied: GeneratedFrame = {
          definitionTag: "release",
          leaseId: testLeaseId("lease-0"),
          decision: "deny",
        };
        yield* registry.dispatch(decodedRelease(denied));
        yield* registry.dispatch(
          decodedRelease({
            definitionTag: "release",
            leaseId: testLeaseId("lease-1"),
            decision: "hold",
          }),
        );

        yield* Effect.yieldNow();
        yield* registry.closeAll;
        yield* Fiber.join(fiber);

        const observed = yield* Ref.get(seen);
        expect(observed).toEqual([releaseParams(denied)]);
      }),
    ));
});

/* eslint-enable max-nested-callbacks, max-lines-per-function, sonarjs/max-lines-per-function, agent-code-guard/async-keyword, jsdoc/text-escaping -- Restore strict defaults after the scoped file-level exception. -- Restore strict defaults after the scoped exception. */
