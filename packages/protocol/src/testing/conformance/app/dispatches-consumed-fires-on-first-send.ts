import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import type { PropertyInvariantViolation } from "../_shared/registry.js";
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
    dispatchesConsumedFiresOnFirstSend(ctx, NAME),
  );
}

const dispatchesConsumedFiresOnFirstSend = (
  ctx: ConformanceRunContext,
  propertyName: string,
) =>
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
      yield* assertMessageSendSucceeded(propertyName, sent.errorCode);
      const consumed = yield* driver.moderator.waitForObservability(
        "consumed",
        { dispatchId: ack.dispatchId },
      );
      const params = consumed.params as ConsumedFrameView;
      yield* assertConsumedLeaseId(propertyName, params.leaseId, ack.leaseId);
      yield* assertConsumedMessageId(propertyName, params.messageId);
    }),
  ).pipe(Effect.withSpan("dispatchesConsumedFiresOnFirstSend"));

const assertMessageSendSucceeded = (
  propertyName: string,
  errorCode: unknown,
): Effect.Effect<void, PropertyInvariantViolation> =>
  errorCode === undefined
    ? Effect.void
    : Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `messages/send unexpectedly failed: code=${String(errorCode)}`,
        ),
      );

const assertConsumedLeaseId = (
  propertyName: string,
  actual: unknown,
  expected: unknown,
): Effect.Effect<void, PropertyInvariantViolation> =>
  actual === expected
    ? Effect.void
    : Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `dispatches/consumed leaseId ${String(actual)} != ack ${String(expected)}`,
        ),
      );

const assertConsumedMessageId = (
  propertyName: string,
  messageId: unknown,
): Effect.Effect<void, PropertyInvariantViolation> =>
  typeof messageId === "string" && isUuidV4(messageId)
    ? Effect.void
    : Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `dispatches/consumed messageId not UUIDv4: ${String(messageId)}`,
        ),
      );
