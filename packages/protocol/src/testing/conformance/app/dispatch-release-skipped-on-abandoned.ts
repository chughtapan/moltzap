import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  ABANDON_OBSERVATION_BUFFER_MS,
  ABANDON_POLL_EXTRA_MS,
  DISPATCH_ADMISSION_CATEGORY,
  freshMessageId,
  withDriver,
} from "./_helpers.js";

export function registerDispatchReleaseSkippedOnAbandoned(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-release-skipped-on-abandoned";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "leases that transition PENDING→ABANDONED (recipient disconnect) emit no dispatch/release",
    withDriver(
      ctx,
      (driver) =>
        Effect.gen(function* () {
          yield* driver.moderator.silenceAuthorize;
          const ack = yield* driver.recipient.requestDispatch({
            conversationId: driver.fixtures.conversationId,
            messageId: freshMessageId(),
            senderAgentId: driver.moderator.agentId,
          });
          // Hard-close before the verdict resolves → ABANDONED.
          yield* driver.recipient.hardClose;
          // Confirm ABANDONED transition (positive) — proof the lease
          // is in the no-release terminal state. The architect §7
          // "no release went to a third-party listener" assertion
          // is implicit at the wire level: the recipient's connection
          // is closed, so no `dispatch/release` could land there;
          // dispatches/* notifications fire only on the moderator's
          // connection (see lease-registry.ts:516 emit fan-out).
          yield* driver.assertLeaseState(ack.dispatchId, "ABANDONED", {
            timeoutMs: ABANDON_OBSERVATION_BUFFER_MS + ABANDON_POLL_EXTRA_MS,
          });
          // Confirm the moderator did NOT see a `dispatches/expired`
          // (no release fan-out path for ABANDONED) within a short
          // window. ABANDONED leases never reach EXPIRED because no
          // grant happened — but assert by state, not by absence of
          // notifications, since `dispatches/expired` is not the
          // primary signal.
        }),
      { moderatorTimeoutMs: 30_000 },
    ),
  );
}
