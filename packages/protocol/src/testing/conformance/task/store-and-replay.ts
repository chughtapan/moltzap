/**
 * Store-and-replay — spec §5 C2: offline-then-reconnect delivers the
 * messages sent during the disconnect window.
 *
 * **Status: architect §4.5 option (b) — property split.**
 *
 * Option (a) (reconnect via scope composition) was attempted and is
 * infrastructure-viable: TestClient supports re-opening with the same
 * apiKey/agentId via `Effect.scoped`, no new public primitive needed.
 * However, the current server implementation does not buffer events
 * for offline subscribers (empirical observation against
 * `startCoreTestServer` at commit time): after reconnect, the
 * participant's capture buffer contains zero of the N messages sent
 * during the offline window. This is a server-side gap against spec
 * §5 C2, not a TestClient gap.
 *
 * Per architect §4.5 option (b), this property is scoped to
 * **basic-delivery-landing** — the weaker invariant that N messages
 * sent to a live conversation land in every currently-subscribed
 * participant's capture buffer. The full offline-replay assertion is
 * deferred pending server-side C2 replay implementation; when it
 * lands, flip this body back to the reconnect form from the git
 * history.
 */
import { Effect } from "effect";
import { MessagesSend } from "@moltzap/protocol/task";
import { isNotificationFrame } from "../_shared/frame-mutator.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
} from "../_shared/registry.js";
import { DELIVERY_CATEGORY, acquireConversation } from "./_helpers.js";

const PROPERTY = "store-and-replay";

export function registerStoreAndReplay(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    DELIVERY_CATEGORY,
    PROPERTY,
    "every messages/send lands in a live participant's capture buffer (basic-delivery-landing; C2 offline-replay deferred)",
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquireConversation(ctx, 1, "sr").pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: DELIVERY_CATEGORY,
                name: PROPERTY,
                reason: `fixture: ${e}`,
              }),
          ),
        );
        const participant = fixture.participants[0];
        if (participant === undefined) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: DELIVERY_CATEGORY,
              name: PROPERTY,
              reason: "fixture missing participant",
            }),
          );
        }
        const sent = 3;
        for (let i = 0; i < sent; i++) {
          yield* fixture.owner.client
            .sendRpc(MessagesSend, {
              conversationId: fixture.conversationId,
              parts: [{ type: "text", text: `sr-${i}` }],
            })
            .pipe(Effect.either);
        }
        yield* Effect.sleep("350 millis");
        const snap = yield* participant.client.snapshot;
        const delivered = snap.filter(
          (s) =>
            s.kind === "inbound" &&
            s.frame !== null &&
            isNotificationFrame(s.frame) &&
            s.frame.method.includes("message"),
        ).length;
        if (delivered < sent) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: DELIVERY_CATEGORY,
              name: PROPERTY,
              reason: `sent ${sent}, live participant observed ${delivered}`,
            }),
          );
        }
      }),
    ),
  );
}
