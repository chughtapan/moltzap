import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  ABANDON_OBSERVATION_BUFFER_MS,
  ABANDON_POLL_EXTRA_MS,
  DISPATCH_ADMISSION_CATEGORY,
  freshMessageId,
  withDriver,
} from "./_helpers.js";

export function registerDispatchRequestRecipientDisconnectAbandons(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-request-recipient-disconnect-abandons-lease";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "closing the recipient's connection while in PENDING transitions the lease to ABANDONED; subsequent app/dispatch/lease/get returns state=ABANDONED",
    withDriver(
      ctx,
      (driver) =>
        Effect.gen(function* () {
          // Silence the moderator → server forks the round-trip but
          // never gets a verdict; lease stays PENDING.
          yield* driver.moderator.silenceAuthorize;
          const ack = yield* driver.recipient.requestDispatch({
            conversationId: driver.fixtures.conversationId,
            messageId: freshMessageId(),
            senderAgentId: driver.moderator.agentId,
          });
          // Hard-close the recipient's WS — server-side connection
          // finalizer fires and transitions the lease to ABANDONED.
          yield* driver.recipient.hardClose;
          // Allow the server-side finalizer to run, then assert via
          // moderator.app/dispatch/lease/get. The driver's poll bound covers
          // the finalizer race window.
          yield* driver.assertLeaseState(ack.dispatchId, "ABANDONED", {
            timeoutMs: ABANDON_OBSERVATION_BUFFER_MS + ABANDON_POLL_EXTRA_MS,
          });
        }),
      // Wide moderator timeout so the silence path holds the round-
      // trip open until the recipient hard-closes.
      { moderatorTimeoutMs: 30_000 },
    ).pipe(
      Effect.withSpan("registerDispatchRequestRecipientDisconnectAbandons"),
    ),
  );
}
