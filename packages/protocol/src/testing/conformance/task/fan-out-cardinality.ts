/**
 * Fan-out cardinality — messages/send ⇒ **exactly** N inbound events
 * (one per connection). The check is `=== N`, not `>= 1`, so a server
 * that duplicates events fails. Empty counts surface as an explicit
 * `PropertyInvariantViolation`.
 */
import * as fc from "fast-check";
import { Effect, type Scope } from "effect";
import {
  MessageReceivedNotificationDefinition,
  MessagesSend,
} from "../../../message/index.js";
import type { NotificationDelivery } from "#transport";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";
import type { PropertyAssertionFailure } from "../_shared/registry.js";
import { leftOrNull } from "../_shared/_helpers.js";
import {
  DELIVERY_CATEGORY,
  DELIVERY_DEFAULT_PROPERTY_NUM_RUNS,
  acquireConversation,
  type ConversationFixture,
  deliveryViolation,
  fixtureN,
} from "./_helpers.js";

function isMessageNotification(frame: NotificationDelivery): boolean {
  return frame.definition === MessageReceivedNotificationDefinition;
}

export function registerFanOutCardinality(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    DELIVERY_CATEGORY,
    "fan-out-cardinality",
    "messages/send ⇒ exactly N inbound message events (one per connection)",
    assertProperty(DELIVERY_CATEGORY, "fan-out-cardinality", (onFailure) =>
      runFanOutCardinalityProperty(ctx, onFailure),
    ).pipe(Effect.withSpan("registerFanOutCardinality")),
  );
}

function runFanOutCardinalityProperty(
  ctx: ConformanceRunContext,
  onFailure: (cause: unknown) => PropertyAssertionFailure,
): Effect.Effect<void, PropertyAssertionFailure> {
  return Effect.tryPromise({
    try: () =>
      fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 3 }), (count) =>
          runFanOutSample(ctx, count),
        ),
        {
          seed: ctx.seed,
          numRuns: ctx.opts.numRuns ?? DELIVERY_DEFAULT_PROPERTY_NUM_RUNS,
        },
      ),
    catch: onFailure,
  });
}

function runFanOutSample(ctx: ConformanceRunContext, count: number) {
  return Effect.runPromise(
    Effect.scoped(observeFanOutCounts(ctx, count)).pipe(
      Effect.map((result) => fanOutCountsAreExact(result, count)),
    ),
  );
}

function observeFanOutCounts(
  ctx: ConformanceRunContext,
  count: number,
): Effect.Effect<
  | { readonly kind: "send-failed" }
  | { readonly kind: "ok"; readonly counts: ReadonlyArray<number> },
  unknown,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const fixture = yield* acquireConversation(ctx, count, "fan").pipe(
      Effect.mapError((e) =>
        deliveryViolation("fan-out-cardinality", `fixture: ${e}`),
      ),
    );
    const sent = yield* sendFanOutMessage(fixture).pipe(Effect.either);
    if (leftOrNull(sent) !== null) return { kind: "send-failed" as const };
    yield* Effect.sleep("250 millis");
    const snapshots = yield* participantSnapshots(fixture);
    return {
      kind: "ok" as const,
      counts: messageNotificationCounts(snapshots),
    };
  });
}

function sendFanOutMessage(fixture: ConversationFixture) {
  return fixture.owner.client.sendRpc(MessagesSend, {
    taskId: fixture.taskId,
    conversationId: fixture.conversationId,
    parts: [{ type: "text", text: "fan-out-ping" }],
  });
}

function participantSnapshots(
  fixture: ConversationFixture,
): Effect.Effect<ReadonlyArray<ReadonlyArray<NotificationDelivery>>> {
  return Effect.forEach(
    fixture.participants,
    (participant) => participant.notifications.snapshot,
    { concurrency: 1 },
  );
}

function messageNotificationCounts(
  snapshots: ReadonlyArray<ReadonlyArray<NotificationDelivery>>,
): ReadonlyArray<number> {
  return snapshots.map(countInboundMessageNotifications);
}

function countInboundMessageNotifications(
  snapshot: ReadonlyArray<NotificationDelivery>,
): number {
  let count = 0;
  for (const entry of snapshot) {
    if (isMessageNotification(entry)) count += 1;
  }
  return count;
}

function fanOutCountsAreExact(
  result:
    | { readonly kind: "send-failed" }
    | { readonly kind: "ok"; readonly counts: ReadonlyArray<number> },
  requestedCount: number,
): boolean {
  if (result.kind !== "ok") return false;
  return (
    result.counts.length === fixtureN(requestedCount) &&
    result.counts.every((count) => count === 1)
  );
}
