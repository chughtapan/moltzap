import { Effect, type Schema } from "effect";
import type { dispatchId, leaseId } from "#message/dispatch";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  dispatchAdmissionViolation,
  freshMessageId,
  withDriver,
} from "./_helpers.js";
import type { DispatchTestDriver } from "./_driver.js";

/**
 * Registers dispatch lease get moderator sees record.
 * @param ctx Context for the operation.
 */
export function registerDispatchLeaseGetModeratorSeesRecord(
  ctx: ConformanceRunContext,
): void {
  const name = "dispatch-lease-get-moderator-sees-record";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    name,
    "app/dispatch/lease/get from the moderator's connection at each lifecycle stage returns the full LeaseRecord with state matching the stage",
    withDriver(ctx, (driver) =>
      assertModeratorSeesLifecycle(name, driver),
    ).pipe(Effect.withSpan("registerDispatchLeaseGetModeratorSeesRecord")),
  );
}

function assertModeratorSeesLifecycle(
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
    yield* assertGrantedView(propertyName, driver, ack);
    yield* consumeLease(propertyName, driver, ack.leaseId);
    yield* assertConsumedView(propertyName, driver, ack.dispatchId);
  });
}

interface DispatchAck {
  readonly leaseId: Schema.Schema.Type<typeof leaseId>;
  readonly dispatchId: Schema.Schema.Type<typeof dispatchId>;
}

function assertGrantedView(
  propertyName: string,
  driver: DispatchTestDriver,
  ack: DispatchAck,
) {
  return Effect.gen(function* () {
    yield* driver.recipient.waitForRelease();
    yield* driver.assertLeaseState(ack.dispatchId, "GRANTED");
    const grantedView = yield* driver.moderator.getLease(ack.dispatchId);
    if (grantedView.leaseId !== ack.leaseId) {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `getLease leaseId ${grantedView.leaseId} != ack ${ack.leaseId}`,
        ),
      );
    }
    if (grantedView.state !== "GRANTED") {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `expected GRANTED, got ${grantedView.state}`,
        ),
      );
    }
    if (grantedView.verdict === null || grantedView.verdict._tag !== "grant") {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `expected verdict.grant, got ${JSON.stringify(grantedView.verdict)}`,
        ),
      );
    }
  });
}

function consumeLease(
  propertyName: string,
  driver: DispatchTestDriver,
  leaseId: DispatchAck["leaseId"],
) {
  return Effect.gen(function* () {
    const sent = yield* driver.recipient.sendWithLease({
      conversationId: driver.fixtures.conversationId,
      leaseId,
      text: "consume-for-getlease-stage",
    });
    if (sent.errorTag !== undefined) {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `agent/message/send failed: code=${sent.errorTag}`,
        ),
      );
    }
  });
}

function assertConsumedView(
  propertyName: string,
  driver: DispatchTestDriver,
  dispatchId: DispatchAck["dispatchId"],
) {
  return Effect.gen(function* () {
    yield* driver.moderator.waitForObservability("consumed", { dispatchId });
    yield* driver.assertLeaseState(dispatchId, "CONSUMED");
    const consumedView = yield* driver.moderator.getLease(dispatchId);
    if (consumedView.state !== "CONSUMED") {
      return yield* Effect.fail(
        dispatchAdmissionViolation(
          propertyName,
          `expected CONSUMED, got ${consumedView.state}`,
        ),
      );
    }
  });
}
