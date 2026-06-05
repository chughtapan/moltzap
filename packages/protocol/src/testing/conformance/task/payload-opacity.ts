/** Payload opacity — sent text appears byte-for-byte in delivered events. */
import * as fc from "fast-check";
import { Effect } from "effect";
import {
  MessageReceivedNotificationDefinition,
  MessagesSend,
} from "../../../message/index.js";
import {
  isNotificationDeliveryFor,
  type NotificationDelivery,
} from "../../../transport/index.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";
import type { PropertyAssertionFailure } from "../_shared/registry.js";
import {
  DELIVERY_CATEGORY,
  DELIVERY_DEFAULT_PROPERTY_NUM_RUNS,
  acquireConversation,
  deliveryViolation,
} from "./_helpers.js";

const PROPERTY = "payload-opacity";

export function registerPayloadOpacity(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    DELIVERY_CATEGORY,
    PROPERTY,
    "sent message text appears verbatim in delivered event bytes",
    assertProperty(DELIVERY_CATEGORY, PROPERTY, (onFailure) =>
      assertPayloadOpacity(ctx, onFailure),
    ).pipe(Effect.withSpan("registerPayloadOpacity")),
  );
}

function assertPayloadOpacity(
  ctx: ConformanceRunContext,
  onFailure: (cause: unknown) => PropertyAssertionFailure,
): Effect.Effect<void, PropertyAssertionFailure> {
  return Effect.tryPromise({
    try: () =>
      fc.assert(
        fc.asyncProperty(payloadTextArbitrary, (text) =>
          Effect.runPromise(checkPayloadOpacity(ctx, text)),
        ),
        {
          seed: ctx.seed,
          numRuns: ctx.opts.numRuns ?? DELIVERY_DEFAULT_PROPERTY_NUM_RUNS,
        },
      ),
    catch: onFailure,
  });
}

const payloadTextArbitrary = fc
  .string({ minLength: 4, maxLength: 24 })
  .filter(isJsonSubstringSafe);

function isJsonSubstringSafe(text: string): boolean {
  return !/[\\" \n\r\t]/.test(text);
}

function checkPayloadOpacity(ctx: ConformanceRunContext, text: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* acquirePayloadFixture(ctx);
      const participant = fixture.participants[0];
      if (participant === undefined) return false;
      yield* fixture.owner.client.sendRpc(MessagesSend, {
        taskId: fixture.taskId,
        conversationId: fixture.conversationId,
        parts: [{ type: "text", text }],
      });
      yield* Effect.sleep("250 millis");
      const snap = yield* participant.notifications.snapshot;
      return snap.some((frame) => containsDeliveredText(frame, text));
    }),
  ).pipe(Effect.catchAll(() => Effect.succeed(false)));
}

function acquirePayloadFixture(ctx: ConformanceRunContext) {
  return acquireConversation(ctx, 1, "po").pipe(
    Effect.mapError((e) => deliveryViolation(PROPERTY, `fixture: ${e}`)),
  );
}

function containsDeliveredText(
  frame: NotificationDelivery,
  text: string,
): boolean {
  if (
    !isNotificationDeliveryFor(frame, MessageReceivedNotificationDefinition)
  ) {
    return false;
  }
  const part = frame.params.message?.parts?.[0];
  return part?.type === "text" && part.text === text;
}
