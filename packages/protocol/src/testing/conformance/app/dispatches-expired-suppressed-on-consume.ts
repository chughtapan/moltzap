import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  NEGATIVE_OBSERVABILITY_WINDOW_MS,
  SHORT_LEASE_TIMEOUT_MS,
  TTL_OBSERVATION_BUFFER_MS,
  dispatchAdmissionViolation,
  freshMessageId,
  withDriver,
} from "./_helpers.js";
import type { DispatchTestDriver } from "./_driver.js";

export function registerDispatchesExpiredSuppressedOnConsumeBeforeTtl(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatches-expired-suppressed-on-consume-before-ttl";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "lease consumed before TTL emits dispatches/consumed (not expired); no dispatches/expired ever fires for this lease",
    withDriver(ctx, (driver) =>
      runExpiredSuppressedOnConsumeBeforeTtl(NAME, driver),
    ).pipe(
      Effect.withSpan("registerDispatchesExpiredSuppressedOnConsumeBeforeTtl"),
    ),
  );
}

function runExpiredSuppressedOnConsumeBeforeTtl(
  propertyName: string,
  driver: DispatchTestDriver,
) {
  return Effect.gen(function* () {
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
    yield* consumeLease(propertyName, driver, ack.leaseId);
    yield* driver.moderator.waitForObservability("consumed", {
      dispatchId: ack.dispatchId,
    });
    yield* driver.assertLeaseState(ack.dispatchId, "CONSUMED");
    yield* assertExpiredNeverFires(propertyName, driver, ack.dispatchId);
  });
}

type LeaseIdValue = Parameters<
  DispatchTestDriver["recipient"]["sendWithLease"]
>[0]["leaseId"];

type DispatchIdValue = Parameters<
  DispatchTestDriver["moderator"]["waitForObservability"]
>[1]["dispatchId"];

function consumeLease(
  propertyName: string,
  driver: DispatchTestDriver,
  leaseId: LeaseIdValue,
) {
  return Effect.gen(function* () {
    const sent = yield* driver.recipient.sendWithLease({
      taskId: driver.fixtures.taskId,
      conversationId: driver.fixtures.conversationId,
      leaseId,
      text: "consume-before-ttl",
    });
    if (sent.errorCode !== undefined) {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `messages/send failed: code=${sent.errorCode}`,
        ),
      );
    }
  });
}

function assertExpiredNeverFires(
  propertyName: string,
  driver: DispatchTestDriver,
  dispatchId: DispatchIdValue,
) {
  return Effect.gen(function* () {
    yield* driver.advanceTime(
      SHORT_LEASE_TIMEOUT_MS + TTL_OBSERVATION_BUFFER_MS,
    );
    const expired = yield* Effect.exit(
      driver.moderator.waitForObservability("expired", {
        dispatchId,
        timeoutMs: NEGATIVE_OBSERVABILITY_WINDOW_MS,
      }),
    );
    if (expired._tag === "Success") {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          "dispatches/expired unexpectedly fired after CONSUMED",
        ),
      );
    }
  });
}
