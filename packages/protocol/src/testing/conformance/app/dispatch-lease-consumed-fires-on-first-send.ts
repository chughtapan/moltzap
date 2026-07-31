import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  registerProperty,
  type PropertyInvariantViolation,
} from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  type ConsumedFrameView,
  dispatchAdmissionViolation,
  freshMessageId,
  isUuidV4,
  withDriver,
} from "./_helpers.js";

/**
 * Registers dispatch lease consumed fires on first send.
 * @param ctx Context for the operation.
 */
export function registerDispatchLeaseConsumedFiresOnFirstSend(
  ctx: ConformanceRunContext,
): void {
  const name = "dispatch-lease-consumed-fires-on-first-send";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    name,
    "first agent/message/send(dispatchLeaseId=X) with X in GRANTED state emits app/dispatch/lease-consumed with the right messageId to the moderator's connection",
    dispatchLeaseConsumedFiresOnFirstSend(ctx, name),
  );
}

function dispatchLeaseConsumedFiresOnFirstSend(
  ctx: ConformanceRunContext,
  propertyName: string,
) {
  return withDriver(ctx, (driver) =>
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
      if (!isConsumedFrameView(consumed.params)) {
        return yield* dispatchAdmissionViolation(
          propertyName,
          "app/dispatch/lease-consumed payload did not contain string leaseId and messageId fields",
        );
      }
      const params = consumed.params;
      yield* assertConsumedLeaseId(propertyName, params.leaseId, ack.leaseId);
      yield* assertConsumedMessageId(propertyName, params.messageId);
    }),
  ).pipe(Effect.withSpan("dispatchLeaseConsumedFiresOnFirstSend"));
}

function isConsumedFrameView(value: unknown): value is ConsumedFrameView {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("leaseId" in value) || typeof value.leaseId !== "string") {
    return false;
  }
  return "messageId" in value && typeof value.messageId === "string";
}

function assertMessageSendSucceeded(
  propertyName: string,
  errorTag: unknown,
): Effect.Effect<void, PropertyInvariantViolation> {
  if (errorTag === undefined) {
    return Effect.void;
  }
  const errorCode =
    typeof errorTag === "string" ? errorTag : "non-string error";
  return Effect.fail(
    dispatchAdmissionViolation(
      propertyName,
      `agent/message/send unexpectedly failed: code=${errorCode}`,
    ),
  );
}

function assertConsumedLeaseId(
  propertyName: string,
  actual: unknown,
  expected: unknown,
): Effect.Effect<void, PropertyInvariantViolation> {
  return actual === expected
    ? Effect.void
    : Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `app/dispatch/lease-consumed leaseId ${String(actual)} != ack ${String(expected)}`,
        ),
      );
}

function assertConsumedMessageId(
  propertyName: string,
  messageId: unknown,
): Effect.Effect<void, PropertyInvariantViolation> {
  return typeof messageId === "string" && isUuidV4(messageId)
    ? Effect.void
    : Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `app/dispatch/lease-consumed messageId not UUIDv4: ${String(messageId)}`,
        ),
      );
}
