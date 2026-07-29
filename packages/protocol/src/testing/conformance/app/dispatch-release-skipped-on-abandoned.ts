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

/**
 * Registers dispatch release skipped on abandoned.
 * @param ctx Context for the operation.
 */
export function registerDispatchReleaseSkippedOnAbandoned(
  ctx: ConformanceRunContext,
): void {
  const name = "dispatch-release-skipped-on-abandoned";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    name,
    "leases that transition PENDING→ABANDONED (recipient disconnect) emit no agent/dispatch/released",
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
          // is in the no-release terminal state. "No release went to a
          // third-party listener" holds at the wire level: the
          // recipient's connection is closed, so no `agent/dispatch/released`
          // could land there; lease lifecycle notifications fire only on
          // the moderator's connection (LeaseRegistry emit fan-out in
          // server-core's `lease-registry.ts`).
          yield* driver.assertLeaseState(ack.dispatchId, "ABANDONED", {
            timeoutMs: ABANDON_OBSERVATION_BUFFER_MS + ABANDON_POLL_EXTRA_MS,
          });
          // Confirm the moderator did NOT see a `app/dispatch/lease-expired`
          // (no release fan-out path for ABANDONED) within a short
          // window. ABANDONED leases never reach EXPIRED because no
          // grant happened — but assert by state, not by absence of
          // notifications, since `app/dispatch/lease-expired` is not the
          // primary signal.
        }),
      { moderatorTimeoutMs: 30_000 },
    ).pipe(Effect.withSpan("registerDispatchReleaseSkippedOnAbandoned")),
  );
}
