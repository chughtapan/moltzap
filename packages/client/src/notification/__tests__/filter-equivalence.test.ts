/**
 * @file Proves that `subscribe` Stream filtering matches a pure JavaScript
 * oracle for generated notification sequences and typed predicates.
 *
 * For any property-generated sequence of inbound notifications and any
 * property-generated typed predicate `p`, the Stream-based `subscribe`
 * output equals the pure-JS reference
 * `frames.filter(frame =&gt; def === frame.definition &amp;&amp; p(frame.params))`.
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
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import { conversationCreatedNotificationDefinition } from "@moltzap/protocol/conversation";
import { messageReceivedNotificationDefinition } from "@moltzap/protocol/message";
import {
  makeNotificationSubscriberRegistry,
  NotConnectedError,
  type NotificationDelivery,
  type NotificationParamsOf,
} from "@moltzap/protocol/rpc";
import { Effect, Fiber, Ref, Stream } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildMessage,
  testAgentId,
  testConversationId,
} from "../../test-utils/index.js";
import { subscribe } from "../stream.js";

/* eslint-disable max-nested-callbacks, max-lines-per-function, sonarjs/max-lines-per-function, agent-code-guard/async-keyword -- fast-check + Effect.gen + Stream.runForEach nest by construction; fc.asyncProperty requires an async function */

const MAX_SEQUENCE_LENGTH = 32;
const VALUE_POOL_SIZE = 8;
const PROPERTY_RUN_COUNT = 25;

type CreatedParams = NotificationParamsOf<
  typeof conversationCreatedNotificationDefinition
>;
type ConversationName = "alpha" | "beta";

const makeSubscriberRegistry = () =>
  makeNotificationSubscriberRegistry<
    NotConnectedError,
    AnyNotificationDefinition
  >({
    closeCause: () =>
      new NotConnectedError({ message: "WebSocket not connected" }),
  });

interface GeneratedFrame {
  readonly definitionTag: "created" | "other";
  readonly conversationId: CreatedParams["conversationId"];
  readonly name: ConversationName;
}

const arbConversationId = fc
  .integer({ min: 0, max: VALUE_POOL_SIZE - 1 })
  .map((n) => testConversationId(`conv-${n}`));

const arbName = fc.constantFrom<ConversationName>("alpha", "beta");

const arbGeneratedFrame: fc.Arbitrary<GeneratedFrame> = fc.record({
  definitionTag: fc.constantFrom<"created" | "other">("created", "other"),
  conversationId: arbConversationId,
  name: arbName,
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
const predicatePool: ReadonlyArray<(params: CreatedParams) => boolean> = [
  (params) => params.name === "alpha",
  (params) => params.name === "beta",
  () => true,
  () => false,
];
const arbPredicate = fc.constantFrom(...predicatePool);

const PARTICIPANTS = [testAgentId("filter-equivalence")];

/**
 * Pure-JS reference oracle. Filters by definition identity + predicate.
 * @param frames Generated frames presented to the notification registry.
 * @param predicate Predicate used to select matching values.
 * @returns Created-notification parameters accepted by both filters.
 */
function oracle(
  frames: readonly GeneratedFrame[],
  predicate: (params: CreatedParams) => boolean,
): readonly CreatedParams[] {
  return frames
    .filter((f) => f.definitionTag === "created")
    .map(createdParams)
    .filter(predicate);
}

function decodedCreated(
  generated: GeneratedFrame,
): NotificationDelivery<typeof conversationCreatedNotificationDefinition> {
  return {
    definition: conversationCreatedNotificationDefinition,
    method: conversationCreatedNotificationDefinition.name,
    params: createdParams(generated),
  };
}

function createdParams(generated: GeneratedFrame): CreatedParams {
  return {
    conversationId: generated.conversationId,
    name: generated.name,
    participants: PARTICIPANTS,
  };
}

function otherFrame(): NotificationDelivery<
  typeof messageReceivedNotificationDefinition
> {
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
            const seen = yield* Ref.make<readonly CreatedParams[]>([]);

            const fiber = yield* Effect.fork(
              subscribe(
                registry,
                conversationCreatedNotificationDefinition,
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
                f.definitionTag === "created"
                  ? decodedCreated(f)
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
        const seen = yield* Ref.make<readonly CreatedParams[]>([]);

        // Type guard form. The Stream's payload is now narrowed at compile-time;
        // the runtime expectation is that no non-matching params arrive.
        type AlphaCreated = CreatedParams & { readonly name: "alpha" };
        const isAlpha = (params: CreatedParams): params is AlphaCreated =>
          params.name === "alpha";

        const fiber = yield* Effect.fork(
          subscribe(
            registry,
            conversationCreatedNotificationDefinition,
            isAlpha,
          ).pipe(
            Stream.runForEach((params) =>
              Ref.update(seen, (xs) => [...xs, params]),
            ),
            Effect.catchAll(() => Effect.void),
          ),
        );
        yield* Effect.yieldNow();

        const alpha: GeneratedFrame = {
          definitionTag: "created",
          conversationId: testConversationId("conv-0"),
          name: "alpha",
        };
        yield* registry.dispatch(decodedCreated(alpha));
        yield* registry.dispatch(
          decodedCreated({
            definitionTag: "created",
            conversationId: testConversationId("conv-1"),
            name: "beta",
          }),
        );

        yield* Effect.yieldNow();
        yield* registry.closeAll;
        yield* Fiber.join(fiber);

        const observed = yield* Ref.get(seen);
        expect(observed).toEqual([createdParams(alpha)]);
      }),
    ));
});

/* eslint-enable max-nested-callbacks, max-lines-per-function, sonarjs/max-lines-per-function, agent-code-guard/async-keyword -- Restore strict defaults after the scoped file-level exception. */
