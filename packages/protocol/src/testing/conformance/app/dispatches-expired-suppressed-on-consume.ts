import { Effect } from "effect";
import type { Static } from "@sinclair/typebox";
import type { LeaseId } from "@moltzap/protocol/app";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  NEGATIVE_OBSERVABILITY_WINDOW_MS,
  SHORT_LEASE_TIMEOUT_MS,
  TTL_OBSERVATION_BUFFER_MS,
  dispatchAdmissionViolation,
  freshMessageId,
  withDriver,
} from "./_helpers.js";

export function registerDispatchesExpiredSuppressedOnConsumeBeforeTtl(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatches-expired-suppressed-on-consume-before-ttl";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "lease consumed before TTL emits dispatches/consumed (not expired); no dispatches/expired ever fires for this lease",
    withDriver(ctx, (driver) =>
      Effect.gen(function* () {
        yield* driver.moderator.handleAuthorize({
          respondWith: {
            _tag: "grant",
            leaseTimeoutMs: SHORT_LEASE_TIMEOUT_MS,
          },
        });
        const ack = yield* driver.recipient.requestDispatch({
          conversationId: driver.fixtures.conversationId,
          messageId: freshMessageId(),
          senderAgentId: driver.moderator.agentId,
        });
        yield* driver.recipient.waitForRelease();
        // Consume immediately, well before the TTL.
        const sent = yield* driver.recipient.sendWithLease({
          conversationId: driver.fixtures.conversationId,
          leaseId: ack.leaseId as Static<typeof LeaseId>,
          text: "consume-before-ttl",
        });
        if (sent.errorCode !== undefined) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `messages/send failed: code=${sent.errorCode}`,
            ),
          );
        }
        // Drain the positive `consumed` notification + its lease state.
        yield* driver.moderator.waitForObservability("consumed", {
          dispatchId: ack.dispatchId,
        });
        yield* driver.assertLeaseState(ack.dispatchId, "CONSUMED");
        // Wait past the TTL and assert no `dispatches/expired` ever
        // fires. (CLAIMED-no-op + post-CONSUME no-op rules.)
        yield* driver.advanceTime(
          SHORT_LEASE_TIMEOUT_MS + TTL_OBSERVATION_BUFFER_MS,
        );
        const expired = yield* Effect.exit(
          driver.moderator.waitForObservability("expired", {
            dispatchId: ack.dispatchId,
            timeoutMs: NEGATIVE_OBSERVABILITY_WINDOW_MS,
          }),
        );
        if (expired._tag === "Success") {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              "dispatches/expired unexpectedly fired after CONSUMED",
            ),
          );
        }
      }),
    ).pipe(
      Effect.withSpan("registerDispatchesExpiredSuppressedOnConsumeBeforeTtl"),
    ),
  );
}
