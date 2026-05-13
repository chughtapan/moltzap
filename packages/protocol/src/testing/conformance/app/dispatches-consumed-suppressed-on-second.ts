import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  FORBIDDEN_ERROR_CODE,
  NEGATIVE_OBSERVABILITY_WINDOW_MS,
  dispatchAdmissionViolation,
  freshMessageId,
  withDriver,
} from "./_helpers.js";

export function registerDispatchesConsumedSuppressedOnSecondSend(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatches-consumed-suppressed-on-second-send";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "second messages/send(dispatchLeaseId=X) with X in CONSUMED state returns typed LeaseInvalidError and does NOT emit a duplicate dispatches/consumed",
    withDriver(ctx, (driver) =>
      Effect.gen(function* () {
        yield* driver.moderator.handleAuthorize({
          respondWith: { _tag: "grant" },
        });
        const ack = yield* driver.recipient.requestDispatch({
          conversationId: driver.fixtures.conversationId,
          messageId: freshMessageId(),
          senderAgentId: driver.moderator.agentId,
        });
        yield* driver.recipient.waitForRelease();
        // First send consumes the lease.
        const first = yield* driver.recipient.sendWithLease({
          conversationId: driver.fixtures.conversationId,
          leaseId: ack.leaseId,
          text: "first",
        });
        if (first.errorCode !== undefined) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `first send failed: code=${first.errorCode}`,
            ),
          );
        }
        // Drain the first dispatches/consumed (positive observability).
        yield* driver.moderator.waitForObservability("consumed", {
          dispatchId: ack.dispatchId,
        });
        // Second send must surface typed LeaseInvalid error
        // (ForbiddenError code -32001 with data.state="CONSUMED").
        // ALSO covers the TTL-skip-on-CLAIMED rule indirectly: if TTL
        // had fired on CLAIMED, the second send would surface EXPIRED;
        // CONSUMED implies TTL was correctly skipped.
        const second = yield* driver.recipient.sendWithLease({
          conversationId: driver.fixtures.conversationId,
          leaseId: ack.leaseId,
          text: "second",
        });
        if (second.errorCode === undefined) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              "second messages/send unexpectedly succeeded; expected LeaseInvalid",
            ),
          );
        }
        if (second.errorCode !== FORBIDDEN_ERROR_CODE) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `second send error code ${second.errorCode} != Forbidden(${FORBIDDEN_ERROR_CODE})`,
            ),
          );
        }
        if (second.errorState !== "CONSUMED") {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `second send LeaseInvalid state ${String(second.errorState)} != CONSUMED`,
            ),
          );
        }
        // Confirm no duplicate dispatches/consumed within a tight
        // window — only the first one fired.
        const dup = yield* Effect.exit(
          driver.moderator.waitForObservability("consumed", {
            dispatchId: ack.dispatchId,
            timeoutMs: NEGATIVE_OBSERVABILITY_WINDOW_MS,
          }),
        );
        if (dup._tag === "Success") {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              "saw a duplicate dispatches/consumed for the second send",
            ),
          );
        }
      }),
    ).pipe(Effect.withSpan("registerDispatchesConsumedSuppressedOnSecondSend")),
  );
}
