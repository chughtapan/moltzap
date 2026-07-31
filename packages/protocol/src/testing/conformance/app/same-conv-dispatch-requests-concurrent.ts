import { Effect, type Schema } from "effect";
import type { dispatchId, leaseId } from "#message/dispatch";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  registerProperty,
  type PropertyInvariantViolation,
} from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  dispatchAdmissionViolation,
  freshMessageId,
  withDriver,
} from "./_helpers.js";
import type { DispatchTestDriver, RecipientHandle } from "./_driver.js";

/**
 * Registers same conversation dispatch requests concurrent.
 * @param ctx Context for the operation.
 */
export function registerSameConversationDispatchRequestsConcurrent(
  ctx: ConformanceRunContext,
): void {
  const name =
    "same-conversation-dispatch-requests-reach-moderator-concurrently";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    name,
    "two agent/dispatch/request calls in same (taskId, conversationId) reach the moderator without server-side serialization",
    withDriver(ctx, (driver) =>
      runSameConversationDispatchRequestsConcurrent(name, driver),
    ).pipe(
      Effect.withSpan("registerSameConversationDispatchRequestsConcurrent"),
    ),
  );
}

function runSameConversationDispatchRequestsConcurrent(
  propertyName: string,
  driver: DispatchTestDriver,
) {
  return Effect.gen(function* () {
    yield* driver.moderator.handleAuthorize({
      respondWith: { _tag: "grant" },
    });
    const second = yield* driver.addRecipient({});
    const [ack1, ack2] = yield* requestConcurrentDispatches(driver, second);
    yield* assertDistinctDispatches(propertyName, ack1, ack2);
    yield* driver.recipient.waitForRelease();
    yield* second.waitForRelease();
  });
}

interface DispatchAck {
  readonly leaseId: Schema.Schema.Type<typeof leaseId>;
  readonly dispatchId: Schema.Schema.Type<typeof dispatchId>;
}

function requestConcurrentDispatches(
  driver: DispatchTestDriver,
  second: RecipientHandle,
) {
  const conversationId = driver.fixtures.conversationId;
  return Effect.all(
    [
      driver.recipient.requestDispatch({
        conversationId,
        messageId: freshMessageId(),
        senderAgentId: driver.moderator.agentId,
      }),
      second.requestDispatch({
        conversationId,
        messageId: freshMessageId(),
        senderAgentId: driver.moderator.agentId,
      }),
    ] as const,
    { concurrency: 2 },
  );
}

function assertDistinctDispatches(
  propertyName: string,
  ack1: DispatchAck,
  ack2: DispatchAck,
): Effect.Effect<void, PropertyInvariantViolation> {
  if (ack1.leaseId === ack2.leaseId) {
    return Effect.fail(
      dispatchAdmissionViolation(
        propertyName,
        "leaseIds collided across concurrent requests",
      ),
    );
  }
  if (ack1.dispatchId === ack2.dispatchId) {
    return Effect.fail(
      dispatchAdmissionViolation(
        propertyName,
        "dispatchIds collided across concurrent requests",
      ),
    );
  }
  return Effect.void;
}
