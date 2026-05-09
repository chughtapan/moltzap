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

export function registerReleaseForOneLeaseDoesNotWaitOnAnother(
  ctx: ConformanceRunContext,
): void {
  const NAME = "release-for-one-lease-does-not-wait-on-another";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "emit-time independence of leases (closes #358 P3)",
    withDriver(
      ctx,
      (driver) =>
        Effect.gen(function* () {
          // Two leases minted; the moderator's reply to the second is
          // fast (no hold), the first is held for several seconds. The
          // recipient's `waitForRelease` for the second lease must
          // resolve before the first lease's release.
          //
          // Use distinct `messageId`s to drive the predicate path: the
          // first request gets a long `holdResponseFor`; the second
          // gets a no-hold handler. Predicates on the first handler
          // narrow it to ONLY the first messageId; the second handler
          // (registered after via last-wins) catches the second.
          const HOLD_MS = 3_000;
          const firstMsgId = freshMessageId();
          const secondMsgId = freshMessageId();
          // First handler — long hold; predicate selects only the
          // first messageId.
          yield* driver.moderator.handleAuthorize({
            respondWith: { _tag: "grant" },
            holdResponseFor: HOLD_MS,
            predicate: ({ messageId }) => messageId === firstMsgId,
          });
          const ack1 = yield* driver.recipient.requestDispatch({
            conversationId: driver.fixtures.conversationId,
            messageId: firstMsgId,
            senderAgentId: driver.moderator.agentId,
          });
          // Overwrite the handler — last-wins. By the time the second
          // request reaches the moderator, the new handler is in place.
          // (The first request's S→C call has ALREADY been
          // dispatched against the previous handler — its in-flight
          // Effect runs to completion in its own fiber.)
          yield* driver.moderator.handleAuthorize({
            respondWith: { _tag: "grant" },
            predicate: ({ messageId }) => messageId === secondMsgId,
          });
          const ack2 = yield* driver.recipient.requestDispatch({
            conversationId: driver.fixtures.conversationId,
            messageId: secondMsgId,
            senderAgentId: driver.moderator.agentId,
          });
          // Expect the second release first.
          const second = yield* driver.recipient.waitForRelease(
            (frame) =>
              (frame.params as LeaseIdOnlyView).leaseId === ack2.leaseId,
            HOLD_MS - HOLD_RELEASE_MARGIN_MS,
          );
          const params2 = second.params as LeaseIdOnlyView;
          if (params2.leaseId !== ack2.leaseId) {
            return yield* Effect.fail(
              dispatchAdmissionViolation(
                NAME,
                `second release leaseId mismatch`,
              ),
            );
          }
          // Drain the first (slow) release — within the hold window
          // plus a generous buffer.
          yield* driver.recipient.waitForRelease(
            (frame) =>
              (frame.params as LeaseIdOnlyView).leaseId === ack1.leaseId,
            HOLD_MS + HOLD_DRAIN_BUFFER_MS,
          );
        }),
      { moderatorTimeoutMs: 15_000 },
    ),
  );
}
