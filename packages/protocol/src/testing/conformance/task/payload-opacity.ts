/** Payload opacity — sent text appears byte-for-byte in delivered events. */
import * as fc from "fast-check";
import { Effect } from "effect";
import { MessagesSend } from "../../../task/methods.js";
import { isNotificationFrame } from "../../codec.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";
import {
  DELIVERY_CATEGORY,
  DELIVERY_DEFAULT_PROPERTY_NUM_RUNS,
  acquireConversation,
  deliveryViolation,
} from "./_helpers.js";

export function registerPayloadOpacity(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    DELIVERY_CATEGORY,
    "payload-opacity",
    "sent message text appears verbatim in delivered event bytes",
    assertProperty(DELIVERY_CATEGORY, "payload-opacity", () =>
      fc.assert(
        fc.asyncProperty(
          // Exclude JSON-meta chars so a simple substring match is valid.
          fc
            .string({ minLength: 4, maxLength: 24 })
            .filter((s) => !/[\\" \n\r\t]/.test(s)),
          (text) =>
            Effect.runPromise(
              Effect.scoped(
                Effect.gen(function* () {
                  const fixture = yield* acquireConversation(ctx, 1, "po").pipe(
                    Effect.mapError((e) =>
                      deliveryViolation("payload-opacity", `fixture: ${e}`),
                    ),
                  );
                  const participant = fixture.participants[0];
                  if (participant === undefined) return false;
                  yield* fixture.owner.client.sendRpc(MessagesSend, {
                    conversationId: fixture.conversationId,
                    parts: [{ type: "text", text }],
                  });
                  yield* Effect.sleep("250 millis");
                  const snap = yield* participant.client.snapshot;
                  return snap.some(
                    (s) =>
                      s.kind === "inbound" &&
                      s.frame !== null &&
                      isNotificationFrame(s.frame) &&
                      s.raw.includes(text),
                  );
                }),
              ).pipe(Effect.catchAll(() => Effect.succeed(false))),
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
