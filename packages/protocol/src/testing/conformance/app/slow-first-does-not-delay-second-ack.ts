import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  FAST_ACK_THRESHOLD_MS,
  dispatchAdmissionViolation,
  freshMessageId,
  withDriver,
} from "./_helpers.js";

export function registerSlowFirstDoesNotDelaySecondAck(
  ctx: ConformanceRunContext,
): void {
  const NAME = "slow-first-moderator-call-does-not-delay-second-ack";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "first moderator round-trip blocks for N seconds; second agent/dispatch/request ack arrives within << N (server-side fork, not blocking on first)",
    withDriver(
      ctx,
      (driver) =>
        Effect.gen(function* () {
          // Hold the moderator response for 5 s on EVERY incoming
          // request — regardless of which lease, both replies are
          // delayed but the SERVER still acks both `agent/dispatch/request`
          // immediately (the fork-and-ack invariant). The second ack
          // observed below MUST land before the moderator's hold
          // elapses; the test bounds the second ack's latency well
          // under the hold window.
          const HOLD_MS = 5_000;
          yield* driver.moderator.handleAuthorize({
            respondWith: { _tag: "grant" },
            holdResponseFor: HOLD_MS,
          });
          const conv = driver.fixtures.conversationId;
          const tStart = Date.now();
          // First agent/dispatch/request (acked immediately by server; the
          // forked moderator round-trip is now blocked for HOLD_MS).
          yield* driver.recipient.requestDispatch({
            conversationId: conv,
            messageId: freshMessageId(),
            senderAgentId: driver.moderator.agentId,
          });
          // Second agent/dispatch/request (still acked immediately).
          yield* driver.recipient.requestDispatch({
            conversationId: conv,
            messageId: freshMessageId(),
            senderAgentId: driver.moderator.agentId,
          });
          const elapsed = Date.now() - tStart;
          // Both acks under FAST_ACK_THRESHOLD_MS — must be much less
          // than HOLD_MS.
          if (elapsed > FAST_ACK_THRESHOLD_MS) {
            return yield* Effect.fail(
              dispatchAdmissionViolation(
                NAME,
                `second ack arrived after ${elapsed}ms (>${FAST_ACK_THRESHOLD_MS}ms); server-side serialization detected`,
              ),
            );
          }
        }),
      // Use a moderator timeout long enough to outlast HOLD_MS so the
      // verdicts eventually settle (and the property's scope-close
      // tear-down is not blocked).
      { moderatorTimeoutMs: 15_000 },
    ).pipe(Effect.withSpan("registerSlowFirstDoesNotDelaySecondAck")),
  );
}
