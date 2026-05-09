import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  dispatchAdmissionViolation,
  freshMessageId,
  type ReleaseFrameView,
  withDriver,
} from "./_helpers.js";

export function registerDispatchAuthorizeVerdictResolves(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-authorize-verdict-resolves-lease";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    "moderator's {grant|deny|hold} reply causes the server to emit dispatch/release with the matching verdict to the recipient",
    Effect.gen(function* () {
      // Three sub-cases: grant, deny, hold. Each gets a fresh driver to
      // isolate cross-verdict state.
      const verdicts: ReadonlyArray<
        | { _tag: "grant" }
        | { _tag: "deny"; reason: string }
        | { _tag: "hold"; reason: string }
      > = [
        { _tag: "grant" },
        { _tag: "deny", reason: "policy" },
        { _tag: "hold", reason: "queued" },
      ];
      for (const verdict of verdicts) {
        yield* withDriver(ctx, (driver) =>
          Effect.gen(function* () {
            yield* driver.moderator.handleAuthorize({ respondWith: verdict });
            const ack = yield* driver.recipient.requestDispatch({
              conversationId: driver.fixtures.conversationId,
              messageId: freshMessageId(),
              senderAgentId: driver.moderator.agentId,
            });
            const release = yield* driver.recipient.waitForRelease();
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
            if (
              verdict._tag !== "grant" &&
              params.verdict.reason !== verdict.reason
            ) {
              return yield* Effect.fail(
                dispatchAdmissionViolation(
                  NAME,
                  `release reason ${String(params.verdict.reason)} != expected ${verdict.reason}`,
                ),
              );
            }
          }),
        );
      }
    }),
  );
}
