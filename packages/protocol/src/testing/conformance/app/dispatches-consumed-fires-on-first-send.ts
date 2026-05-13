import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  type ConsumedFrameView,
  dispatchAdmissionViolation,
  freshMessageId,
  isUuidV4,
  withDriver,
} from "./_helpers.js";

export function registerDispatchesConsumedFiresOnFirstSend(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatches-consumed-fires-on-first-send";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "first messages/send(dispatchLeaseId=X) with X in GRANTED state emits dispatches/consumed with the right messageId to the moderator's connection",
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
        const sent = yield* driver.recipient.sendWithLease({
          conversationId: driver.fixtures.conversationId,
          leaseId: ack.leaseId,
          text: "consumed",
        });
        if (sent.errorCode !== undefined) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `messages/send unexpectedly failed: code=${sent.errorCode}`,
            ),
          );
        }
        const consumed = yield* driver.moderator.waitForObservability(
          "consumed",
          { dispatchId: ack.dispatchId },
        );
        const params = consumed.params as ConsumedFrameView;
        if (params.leaseId !== ack.leaseId) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `dispatches/consumed leaseId ${params.leaseId} != ack ${ack.leaseId}`,
            ),
          );
        }
        if (
          typeof params.messageId !== "string" ||
          !isUuidV4(params.messageId)
        ) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `dispatches/consumed messageId not UUIDv4: ${String(params.messageId)}`,
            ),
          );
        }
      }),
    ).pipe(Effect.withSpan("registerDispatchesConsumedFiresOnFirstSend")),
  );
}
