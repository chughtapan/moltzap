import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  FORBIDDEN_ERROR_TAG,
  NEGATIVE_OBSERVABILITY_WINDOW_MS,
  dispatchAdmissionViolation,
  freshMessageId,
  withDriver,
} from "./_helpers.js";
import type { DispatchTestDriver } from "./_driver.js";

/**
 * Registers dispatch lease consumed suppressed on second send.
 * @param ctx Context for the operation.
 */
export function registerDispatchLeaseConsumedSuppressedOnSecondSend(
  ctx: ConformanceRunContext,
): void {
  const name = "dispatch-lease-consumed-suppressed-on-second-send";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    name,
    "second agent/message/send(dispatchLeaseId=X) with X in CONSUMED state returns typed LeaseInvalidError and does NOT emit a duplicate app/dispatch/lease-consumed",
    withDriver(ctx, (driver) =>
      runConsumedSuppressedOnSecond(name, driver),
    ).pipe(
      Effect.withSpan("registerDispatchLeaseConsumedSuppressedOnSecondSend"),
    ),
  );
}

function runConsumedSuppressedOnSecond(
  propertyName: string,
  driver: DispatchTestDriver,
) {
  return Effect.gen(function* () {
    yield* driver.moderator.handleAuthorize({
      respondWith: { _tag: "grant" },
    });
    const ack = yield* driver.recipient.requestDispatch({
      conversationId: driver.fixtures.conversationId,
      messageId: freshMessageId(),
      senderAgentId: driver.moderator.agentId,
    });
    yield* driver.recipient.waitForRelease();
    yield* assertFirstSendConsumes(propertyName, driver, ack.leaseId);
    yield* driver.moderator.waitForObservability("consumed", {
      dispatchId: ack.dispatchId,
    });
    yield* assertSecondSendRejected(propertyName, driver, ack.leaseId);
    yield* assertNoDuplicateConsumed(propertyName, driver, ack.dispatchId);
  });
}

function assertFirstSendConsumes(
  propertyName: string,
  driver: DispatchTestDriver,
  leaseId: Parameters<
    DispatchTestDriver["recipient"]["sendWithLease"]
  >[0]["leaseId"],
) {
  return Effect.gen(function* () {
    const first = yield* driver.recipient.sendWithLease({
      taskId: driver.fixtures.taskId,
      conversationId: driver.fixtures.conversationId,
      leaseId,
      text: "first",
    });
    if (first.errorTag !== undefined) {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `first send failed: code=${first.errorTag}`,
        ),
      );
    }
  });
}

function assertSecondSendRejected(
  propertyName: string,
  driver: DispatchTestDriver,
  leaseId: Parameters<
    DispatchTestDriver["recipient"]["sendWithLease"]
  >[0]["leaseId"],
) {
  return Effect.gen(function* () {
    const second = yield* driver.recipient.sendWithLease({
      taskId: driver.fixtures.taskId,
      conversationId: driver.fixtures.conversationId,
      leaseId,
      text: "second",
    });
    if (second.errorTag === undefined) {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          "second agent/message/send unexpectedly succeeded; expected LeaseInvalid",
        ),
      );
    }
    yield* assertSecondErrorCode(propertyName, second.errorTag);
    const errorState = second.errorState;
    if (errorState === undefined) {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          "second send LeaseInvalid state <missing> != CONSUMED",
        ),
      );
    }
    yield* assertSecondErrorState(propertyName, errorState);
  });
}

function assertSecondErrorCode(propertyName: string, errorTag: string) {
  return errorTag === FORBIDDEN_ERROR_TAG
    ? Effect.void
    : Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `second send error code ${errorTag} != Forbidden(${FORBIDDEN_ERROR_TAG})`,
        ),
      );
}

function assertSecondErrorState(propertyName: string, errorState: string) {
  return errorState === "CONSUMED"
    ? Effect.void
    : Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `second send LeaseInvalid state ${String(errorState)} != CONSUMED`,
        ),
      );
}

function assertNoDuplicateConsumed(
  propertyName: string,
  driver: DispatchTestDriver,
  dispatchId: Parameters<
    DispatchTestDriver["moderator"]["waitForObservability"]
  >[1]["dispatchId"],
) {
  return Effect.gen(function* () {
    const dup = yield* Effect.exit(
      driver.moderator.waitForObservability("consumed", {
        dispatchId,
        timeoutMs: NEGATIVE_OBSERVABILITY_WINDOW_MS,
      }),
    );
    if (dup._tag === "Success") {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          "saw a duplicate app/dispatch/lease-consumed for the second send",
        ),
      );
    }
  });
}
