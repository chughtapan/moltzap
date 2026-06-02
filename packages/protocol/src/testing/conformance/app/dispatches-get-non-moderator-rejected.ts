import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  FORBIDDEN_ERROR_TAG,
  dispatchAdmissionViolation,
  freshMessageId,
  withDriver,
} from "./_helpers.js";

export function registerDispatchesGetNonModeratorRejected(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatches-get-non-moderator-rejected";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "dispatches/get from any non-moderator connection (including the recipient) returns typed ForbiddenError",
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
        const result = yield* driver.getLeaseFromNonModerator(ack.dispatchId);
        if (result.errorTag !== FORBIDDEN_ERROR_TAG) {
          return yield* Effect.fail(
            dispatchAdmissionViolation(
              NAME,
              `expected Forbidden(${FORBIDDEN_ERROR_TAG}), got ${result.errorTag}`,
            ),
          );
        }
      }),
    ).pipe(Effect.withSpan("registerDispatchesGetNonModeratorRejected")),
  );
}
