import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  dispatchAdmissionViolation,
  freshMessageId,
  isUuidV4,
  withDriver,
} from "./_helpers.js";

/**
 * Registers dispatch request ack mints lease.
 * @param ctx Context for the operation.
 */
export function registerDispatchRequestAckMintsLease(
  ctx: ConformanceRunContext,
): void {
  const name = "dispatch-request-ack-mints-lease";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    name,
    "agent/dispatch/request ack returns {leaseId, dispatchId}, both well-formed UUIDv4 (>=122 bits entropy) and distinct from each other",
    withDriver(ctx, (driver) =>
      Effect.gen(function* () {
        // Use a high-grant verdict so the lease resolves quickly and the
        // server-side fork doesn't leave artifacts at scope close.
        yield* driver.moderator.handleAuthorize({
          respondWith: { _tag: "grant" },
        });
        const ack = yield* driver.recipient.requestDispatch({
          conversationId: driver.fixtures.conversationId,
          messageId: freshMessageId(),
          senderAgentId: driver.moderator.agentId,
        });
        if (typeof ack.leaseId !== "string" || !isUuidV4(ack.leaseId)) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              name,
              `leaseId not UUIDv4: ${String(ack.leaseId)}`,
            ),
          );
        }
        if (typeof ack.dispatchId !== "string" || !isUuidV4(ack.dispatchId)) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              name,
              `dispatchId not UUIDv4: ${String(ack.dispatchId)}`,
            ),
          );
        }
        if ((ack.leaseId as string) === (ack.dispatchId as string)) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              name,
              "leaseId and dispatchId must differ",
            ),
          );
        }
        yield* driver.recipient.waitForRelease();
      }),
    ).pipe(Effect.withSpan("registerDispatchRequestAckMintsLease")),
  );
}
