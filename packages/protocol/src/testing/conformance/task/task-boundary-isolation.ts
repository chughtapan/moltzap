/** Task-boundary isolation — conversation A's events don't leak into B. */
import { Effect } from "effect";
import {
  MessageReceivedNotificationDefinition,
  MessagesSend,
} from "@moltzap/protocol/message";
import { isNotificationDeliveryFor } from "#transport";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
} from "../_shared/registry.js";
import {
  DELIVERY_CATEGORY,
  acquireConversation,
  deliveryViolation,
} from "./_helpers.js";

const PROPERTY = "task-boundary-isolation";

const taskBoundaryIsolation = (ctx: ConformanceRunContext) =>
  Effect.gen(function* () {
    const fxA = yield* acquireConversation(ctx, 1, "iso-a").pipe(
      Effect.mapError((e) => deliveryViolation(PROPERTY, `fixture A: ${e}`)),
    );
    const fxB = yield* acquireConversation(ctx, 1, "iso-b").pipe(
      Effect.mapError((e) => deliveryViolation(PROPERTY, `fixture B: ${e}`)),
    );
    yield* fxA.owner.client
      .sendRpc(MessagesSend, {
        taskId: fxA.taskId,
        conversationId: fxA.conversationId,
        parts: [{ type: "text", text: "iso-leak-canary" }],
      })
      .pipe(Effect.either);
    yield* Effect.sleep("250 millis");
    const outsider = fxB.participants[0];
    if (outsider === undefined) return;
    const snap = yield* outsider.notifications.snapshot;
    const leaked = snap.some(
      (s) =>
        isNotificationDeliveryFor(s, MessageReceivedNotificationDefinition) &&
        s.params.message.conversationId === fxA.conversationId,
    );
    if (leaked) {
      return yield* Effect.fail(
        new PropertyInvariantViolation({
          category: DELIVERY_CATEGORY,
          name: PROPERTY,
          reason: `conversation ${fxA.conversationId} leaked into outsider ${outsider.agent.agentId}`,
        }),
      );
    }
  }).pipe(Effect.withSpan("registerTaskBoundaryIsolation"));

export function registerTaskBoundaryIsolation(
  ctx: ConformanceRunContext,
): void {
  registerProperty(
    ctx,
    DELIVERY_CATEGORY,
    PROPERTY,
    "participants in conversation B observe zero leaks from conversation A",
    Effect.scoped(taskBoundaryIsolation(ctx)),
  );
}
