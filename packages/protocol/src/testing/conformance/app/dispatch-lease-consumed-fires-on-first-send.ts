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

export function registerDispatchLeaseConsumedFiresOnFirstSend(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-lease-consumed-fires-on-first-send";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "first agent/message/send(dispatchLeaseId=X) with X in GRANTED state emits app/dispatch/lease-consumed with the right messageId to the moderator's connection",
    dispatchLeaseConsumedFiresOnFirstSend(ctx, NAME),
  );
}

const dispatchLeaseConsumedFiresOnFirstSend = (
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
        taskId: driver.fixtures.taskId,
        conversationId: driver.fixtures.conversationId,
        leaseId: ack.leaseId,
        text: "consumed",
      });
      yield* assertMessageSendSucceeded(propertyName, sent.errorTag);
      const consumed = yield* driver.moderator.waitForObservability(
        "consumed",
        { dispatchId: ack.dispatchId },
      );
      const params = consumed.params as ConsumedFrameView;
      yield* assertConsumedLeaseId(propertyName, params.leaseId, ack.leaseId);
      yield* assertConsumedMessageId(propertyName, params.messageId);
    }),
  ).pipe(Effect.withSpan("dispatchLeaseConsumedFiresOnFirstSend"));

const assertMessageSendSucceeded = (
  propertyName: string,
  errorTag: unknown,
): Effect.Effect<void, PropertyInvariantViolation> =>
  errorTag === undefined
    ? Effect.void
    : Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `agent/message/send unexpectedly failed: code=${String(errorTag)}`,
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
          `app/dispatch/lease-consumed leaseId ${String(actual)} != ack ${String(expected)}`,
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
          `app/dispatch/lease-consumed messageId not UUIDv4: ${String(messageId)}`,
        ),
      );
