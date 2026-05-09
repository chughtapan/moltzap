import { Effect } from "effect";
import type { Static } from "@sinclair/typebox";
import type { LeaseId } from "../../../app/index.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  dispatchAdmissionViolation,
  freshMessageId,
  withDriver,
} from "./_helpers.js";

export function registerDispatchesGetModeratorSeesRecord(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatches-get-moderator-sees-record";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "dispatches/get from the moderator's connection at each lifecycle stage returns the full LeaseRecord with state matching the stage",
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
        // Stage 1: PENDING → GRANTED transition (architect plan §3
        // state machine). Once `assertLeaseState` sees GRANTED, the
        // moderator's view is settled.
        yield* driver.recipient.waitForRelease();
        yield* driver.assertLeaseState(ack.dispatchId, "GRANTED");
        const grantedView = yield* driver.moderator.getLease(ack.dispatchId);
        if (grantedView.leaseId !== ack.leaseId) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `getLease leaseId ${grantedView.leaseId} != ack ${ack.leaseId}`,
            ),
          );
        }
        if (grantedView.state !== "GRANTED") {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `expected GRANTED, got ${grantedView.state}`,
            ),
          );
        }
        if (
          grantedView.verdict === null ||
          grantedView.verdict._tag !== "grant"
        ) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `expected verdict.grant, got ${JSON.stringify(grantedView.verdict)}`,
            ),
          );
        }
        // Stage 2: GRANTED → CONSUMED via messages/send.
        const sent = yield* driver.recipient.sendWithLease({
          conversationId: driver.fixtures.conversationId,
          leaseId: ack.leaseId as Static<typeof LeaseId>,
          text: "consume-for-getlease-stage",
        });
        if (sent.errorCode !== undefined) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `messages/send failed: code=${sent.errorCode}`,
            ),
          );
        }
        yield* driver.moderator.waitForObservability("consumed", {
          dispatchId: ack.dispatchId,
        });
        yield* driver.assertLeaseState(ack.dispatchId, "CONSUMED");
        const consumedView = yield* driver.moderator.getLease(ack.dispatchId);
        if (consumedView.state !== "CONSUMED") {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `expected CONSUMED, got ${consumedView.state}`,
            ),
          );
        }
      }),
    ),
  );
}
