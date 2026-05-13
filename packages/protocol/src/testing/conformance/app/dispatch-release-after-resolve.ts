import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  NO_SECOND_RELEASE_WINDOW_MS,
  dispatchAdmissionViolation,
  freshMessageId,
  type ReleaseFrameView,
  withDriver,
} from "./_helpers.js";

function expectedLeaseState(verdict: {
  readonly _tag: "grant" | "deny" | "hold";
}): "GRANTED" | "DENIED" | "HOLD" {
  if (verdict._tag === "grant") return "GRANTED";
  if (verdict._tag === "deny") return "DENIED";
  return "HOLD";
}

export function registerDispatchReleaseFiresAfterResolve(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-release-fires-after-resolve";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "for every resolved lease (grant/deny/hold), exactly one dispatch/release reaches the recipient",
    Effect.gen(function* () {
      for (const verdict of [
        { _tag: "grant" as const },
        { _tag: "deny" as const, reason: "policy" },
        { _tag: "hold" as const, reason: "queued" },
      ]) {
        yield* withDriver(ctx, (driver) =>
          Effect.gen(function* () {
            yield* driver.moderator.handleAuthorize({ respondWith: verdict });
            const ack = yield* driver.recipient.requestDispatch({
              conversationId: driver.fixtures.conversationId,
              messageId: freshMessageId(),
              senderAgentId: driver.moderator.agentId,
            });
            // Expected lease state per architect plan §3 + Final Decisions:
            // grant → GRANTED, deny → DENIED, hold → HOLD.
            const expected = expectedLeaseState(verdict);
            yield* driver.assertLeaseState(ack.dispatchId, expected);
            const release = yield* driver.recipient.waitForRelease();
            // Assert exactly one release: collect a second within a
            // tight window and assert no further frame arrived.
            const followup = yield* Effect.exit(
              driver.recipient.waitForRelease(
                undefined,
                NO_SECOND_RELEASE_WINDOW_MS,
              ),
            );
            if (followup._tag === "Success") {
              return yield* Effect.fail(
                dispatchAdmissionViolation(
                  NAME,
                  `expected exactly one dispatch/release per lease; got a second frame`,
                ),
              );
            }
            // First release must match the lease + verdict.
            const params = release.params as ReleaseFrameView;
            if (params.leaseId !== ack.leaseId) {
              return yield* Effect.fail(
                dispatchAdmissionViolation(
                  NAME,
                  `release leaseId ${params.leaseId} != ack ${ack.leaseId}`,
                ),
              );
            }
            if (params.verdict.decision !== verdict._tag) {
              return yield* Effect.fail(
                dispatchAdmissionViolation(
                  NAME,
                  `release decision ${params.verdict.decision} != expected ${verdict._tag}`,
                ),
              );
            }
          }),
        );
      }
    }).pipe(Effect.withSpan("registerDispatchReleaseFiresAfterResolve")),
  );
}
