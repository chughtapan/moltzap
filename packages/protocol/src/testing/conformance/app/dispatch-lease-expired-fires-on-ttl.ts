import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  SHORT_LEASE_TIMEOUT_MS,
  TTL_OBSERVATION_BUFFER_MS,
  dispatchAdmissionViolation,
  freshMessageId,
  type LeaseIdOnlyView,
  withDriver,
} from "./_helpers.js";

export function registerDispatchLeaseExpiredFiresOnTtl(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-lease-expired-fires-on-ttl";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "granted-but-unused lease emits app/dispatch/lease-expired to the moderator after leaseTimeoutMs elapses; lease state advances to EXPIRED",
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
        // Sleep past the lease TTL — the server-side scheduled fiber
        // fires `app/dispatch/lease-expired` to the moderator and advances
        // the lease to EXPIRED.
        yield* driver.advanceTime(
          SHORT_LEASE_TIMEOUT_MS + TTL_OBSERVATION_BUFFER_MS,
        );
        const expired = yield* driver.moderator.waitForObservability(
          "expired",
          { dispatchId: ack.dispatchId, timeoutMs: 2_000 },
        );
        const params = expired.params as LeaseIdOnlyView;
        if (params.leaseId !== ack.leaseId) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `app/dispatch/lease-expired leaseId ${params.leaseId} != ack ${ack.leaseId}`,
            ),
          );
        }
        yield* driver.assertLeaseState(ack.dispatchId, "EXPIRED");
      }),
    ).pipe(Effect.withSpan("registerDispatchLeaseExpiredFiresOnTtl")),
  );
}
