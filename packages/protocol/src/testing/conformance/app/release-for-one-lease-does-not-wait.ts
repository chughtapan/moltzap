import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  HOLD_DRAIN_BUFFER_MS,
  HOLD_RELEASE_MARGIN_MS,
  type LeaseIdOnlyView,
  dispatchAdmissionViolation,
  freshMessageId,
  withDriver,
} from "./_helpers.js";
import type { DispatchTestDriver } from "./_driver.js";

const HOLD_MS = 3_000;

/**
 * Registers release for one lease does not wait on another.
 * @param ctx Context for the operation.
 */
export function registerReleaseForOneLeaseDoesNotWaitOnAnother(
  ctx: ConformanceRunContext,
): void {
  const name = "release-for-one-lease-does-not-wait-on-another";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    name,
    "emit-time independence of leases",
    withDriver(ctx, (driver) => assertReleaseIndependence(name, driver), {
      moderatorTimeoutMs: 15_000,
    }).pipe(Effect.withSpan("registerReleaseForOneLeaseDoesNotWaitOnAnother")),
  );
}

function assertReleaseIndependence(
  propertyName: string,
  driver: DispatchTestDriver,
) {
  return Effect.gen(function* () {
    const firstMsgId = freshMessageId();
    const secondMsgId = freshMessageId();
    const ack1 = yield* requestHeldLease(driver, firstMsgId);
    const ack2 = yield* requestFastLease(driver, secondMsgId);
    yield* assertSecondReleaseArrivesFirst(propertyName, driver, ack2.leaseId);
    yield* driver.recipient.waitForRelease(
      matchesLeaseId(ack1.leaseId),
      HOLD_MS + HOLD_DRAIN_BUFFER_MS,
    );
  });
}

type MessageIdValue = Parameters<
  DispatchTestDriver["recipient"]["requestDispatch"]
>[0]["messageId"];

type LeaseIdValue = Parameters<
  DispatchTestDriver["recipient"]["sendWithLease"]
>[0]["leaseId"];

function requestHeldLease(
  driver: DispatchTestDriver,
  messageId: MessageIdValue,
) {
  return Effect.gen(function* () {
    yield* driver.moderator.handleAuthorize({
      respondWith: { _tag: "grant" },
      holdResponseFor: HOLD_MS,
      predicate: (params) => params.messageId === messageId,
    });
    return yield* requestDispatchForMessage(driver, messageId);
  });
}

function requestFastLease(
  driver: DispatchTestDriver,
  messageId: MessageIdValue,
) {
  return Effect.gen(function* () {
    yield* driver.moderator.handleAuthorize({
      respondWith: { _tag: "grant" },
      predicate: (params) => params.messageId === messageId,
    });
    return yield* requestDispatchForMessage(driver, messageId);
  });
}

function requestDispatchForMessage(
  driver: DispatchTestDriver,
  messageId: MessageIdValue,
) {
  return driver.recipient.requestDispatch({
    conversationId: driver.fixtures.conversationId,
    messageId,
    senderAgentId: driver.moderator.agentId,
  });
}

function assertSecondReleaseArrivesFirst(
  propertyName: string,
  driver: DispatchTestDriver,
  leaseId: LeaseIdValue,
) {
  return Effect.gen(function* () {
    const second = yield* driver.recipient.waitForRelease(
      matchesLeaseId(leaseId),
      HOLD_MS - HOLD_RELEASE_MARGIN_MS,
    );
    const params =
      /* Safe because waitForRelease returns only released-notification deliveries. */ second.params as LeaseIdOnlyView;
    if (params.leaseId !== leaseId) {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          "second release leaseId mismatch",
        ),
      );
    }
  });
}

function matchesLeaseId(leaseId: LeaseIdValue) {
  return (frame: { readonly params: unknown }) =>
    typeof frame.params === "object" &&
    frame.params !== null &&
    Reflect.get(frame.params, "leaseId") === leaseId;
}
