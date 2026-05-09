/**
 * Fan-out cardinality — spec §5 C1: messages/send ⇒ **exactly** N
 * inbound events (one per connection). Architect §4.4: tightened from
 * `>=1` to `===1`; a server that duplicates events now fails.
 *
 * Empty-counts side channel replaced with an explicit
 * `PropertyInvariantViolation`.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import { MessagesSend } from "../../../task/methods.js";
import { isNotificationFrame } from "../../codec.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";
import { leftOrNull } from "../_shared/_helpers.js";
import {
  DELIVERY_CATEGORY,
  DELIVERY_DEFAULT_PROPERTY_NUM_RUNS,
  acquireConversation,
  deliveryViolation,
  fixtureN,
} from "./_helpers.js";

export function registerFanOutCardinality(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    DELIVERY_CATEGORY,
    "fan-out-cardinality",
    "messages/send ⇒ exactly N inbound message events (one per connection)",
    assertProperty(DELIVERY_CATEGORY, "fan-out-cardinality", () =>
      fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 3 }), (n) =>
          Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const fixture = yield* acquireConversation(ctx, n, "fan").pipe(
                  Effect.mapError((e) =>
                    deliveryViolation("fan-out-cardinality", `fixture: ${e}`),
                  ),
                );
                const send = yield* fixture.owner.client
                  .sendRpc(MessagesSend, {
                    conversationId: fixture.conversationId,
                    parts: [{ type: "text", text: "fan-out-ping" }],
                  })
                  .pipe(Effect.either);
                if (leftOrNull(send) !== null) {
                  return { kind: "send-failed" as const };
                }
                yield* Effect.sleep("250 millis");
                const observed = yield* Effect.forEach(
                  fixture.participants,
                  (p) => p.client.snapshot,
                );
                const counts = observed.map(
                  (snap) =>
                    snap.filter(
                      (s) =>
                        s.kind === "inbound" &&
                        s.frame !== null &&
                        isNotificationFrame(s.frame) &&
                        s.frame.method.includes("message"),
                    ).length,
                );
                return { kind: "ok" as const, counts };
              }),
            ).pipe(
              Effect.map((result) => {
                if (result.kind !== "ok") return false;
                // Exact-cardinality predicate. Duplicates and drops both fail.
                return (
                  result.counts.length === fixtureN(n) &&
                  result.counts.every((c) => c === 1)
                );
              }),
            ),
          ),
        ),
        {
          seed: ctx.seed,
          numRuns: ctx.opts.numRuns ?? DELIVERY_DEFAULT_PROPERTY_NUM_RUNS,
        },
      ),
    ),
  );
}
