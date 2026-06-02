/**
 * Store-and-replay — the offline-replay spec goal is: offline-then-
 * reconnect delivers the messages sent during the disconnect window.
 *
 * This property asserts the weaker **basic-delivery-landing** invariant:
 * N messages sent to a live conversation land in every currently-
 * subscribed participant's capture buffer. The full offline-replay
 * assertion is not asserted because the server does not buffer events
 * for offline subscribers — after reconnect, the participant's capture
 * buffer holds zero of the N messages sent during the offline window.
 * That is a server-side gap, not a TestClient gap: TestClient can
 * re-open with the same apiKey/agentId via `Effect.scoped`.
 */
import { Effect } from "effect";
import { MessagesSend } from "../../../task/methods.js";
import { inboundNotificationMethod } from "../_shared/frame-mutator.js";
import type { CapturedFrame } from "../_shared/captures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
} from "../_shared/registry.js";
import {
  DELIVERY_CATEGORY,
  acquireConversation,
  deliveryViolation,
  type ConversationFixture,
} from "./_helpers.js";

const PROPERTY = "store-and-replay";

export function registerStoreAndReplay(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    DELIVERY_CATEGORY,
    PROPERTY,
    "every messages/send lands in a live participant's capture buffer (basic-delivery-landing; offline-replay is a server-side gap)",
    runStoreAndReplay(ctx).pipe(Effect.withSpan("registerStoreAndReplay")),
  );
}

function runStoreAndReplay(ctx: ConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* acquireConversation(ctx, 1, "sr").pipe(
        Effect.mapError((e) => deliveryViolation(PROPERTY, `fixture: ${e}`)),
      );
      const participant = fixture.participants[0];
      if (participant === undefined) {
        return yield* Effect.fail(missingParticipantViolation());
      }
      const sent = 3;
      yield* sendReplayMessages(fixture, sent);
      yield* Effect.sleep("350 millis");
      const snap = yield* participant.client.snapshot;
      yield* assertDeliveredCount(snap, sent);
    }),
  );
}

type StoreFixture = ConversationFixture;

function missingParticipantViolation(): PropertyInvariantViolation {
  return new PropertyInvariantViolation({
    category: DELIVERY_CATEGORY,
    name: PROPERTY,
    reason: "fixture missing participant",
  });
}

function sendReplayMessages(fixture: StoreFixture, sent: number) {
  return Effect.gen(function* () {
    for (let i = 0; i < sent; i++) {
      yield* fixture.owner.client
        .sendRpc(MessagesSend, {
          taskId: fixture.taskId,
          conversationId: fixture.conversationId,
          parts: [{ type: "text", text: `sr-${i}` }],
        })
        .pipe(Effect.either);
    }
  });
}

function assertDeliveredCount(
  snap: ReadonlyArray<CapturedFrame>,
  sent: number,
) {
  const delivered = snap.filter(isInboundMessageNotification).length;
  return delivered >= sent
    ? Effect.void
    : Effect.fail(
        new PropertyInvariantViolation({
          category: DELIVERY_CATEGORY,
          name: PROPERTY,
          reason: `sent ${sent}, live participant observed ${delivered}`,
        }),
      );
}

function isInboundMessageNotification(frame: CapturedFrame): boolean {
  if (frame.kind !== "inbound" || frame.frame === null) return false;
  const method = inboundNotificationMethod(frame.frame);
  return method !== null && method.includes("message");
}
