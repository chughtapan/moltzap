import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  dispatchAdmissionViolation,
  freshMessageId,
  withDriver,
} from "./_helpers.js";

export function registerSameConversationDispatchesConcurrent(
  ctx: ConformanceRunContext,
): void {
  const NAME = "same-conversation-dispatches-reach-moderator-concurrently";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "two dispatch/request calls in same (taskId, conversationId) reach the moderator without server-side serialization (closes #358 P1)",
    withDriver(ctx, (driver) =>
      Effect.gen(function* () {
        // Two recipients in the same conversation issue dispatch/request
        // concurrently; both round-trips must reach the moderator
        // without the server serializing them.
        yield* driver.moderator.handleAuthorize({
          respondWith: { _tag: "grant" },
        });
        const second = yield* driver.addRecipient({});
        const conv = driver.fixtures.conversationId;
        const [ack1, ack2] = yield* Effect.all(
          [
            driver.recipient.requestDispatch({
              conversationId: conv,
              messageId: freshMessageId(),
              senderAgentId: driver.moderator.agentId,
            }),
            second.requestDispatch({
              conversationId: conv,
              messageId: freshMessageId(),
              senderAgentId: driver.moderator.agentId,
            }),
          ] as const,
          // Two recipients in parallel — the architect §7 row asserts
          // both round-trips reach the moderator without server-side
          // serialization, so we want overlapping execution. Bounded
          // concurrency = 2 (one per recipient).
          { concurrency: 2 },
        );
        if (ack1.leaseId === ack2.leaseId) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              "leaseIds collided across concurrent requests",
            ),
          );
        }
        if (ack1.dispatchId === ack2.dispatchId) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              "dispatchIds collided across concurrent requests",
            ),
          );
        }
        // Both verdicts arrive (architect §7: handleAuthorize is called
        // twice within Effect.fork overlap).
        yield* driver.recipient.waitForRelease();
        yield* second.waitForRelease();
      }),
    ).pipe(Effect.withSpan("registerSameConversationDispatchesConcurrent")),
  );
}
