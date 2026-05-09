import { Effect } from "effect";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import {
  DISPATCH_ADMISSION_CATEGORY,
  TIMEOUT_RELEASE_WAIT_MS,
  TINY_MODERATOR_TIMEOUT_MS,
  dispatchAdmissionViolation,
  freshMessageId,
  type ReleaseFrameView,
  withDriver,
} from "./_helpers.js";

export function registerDispatchAuthorizeTimeoutSynthesizesDeny(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-authorize-timeout-synthesizes-deny";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    NAME,
    'moderator never replies within timeout_ms; server emits dispatch/release{deny, reason: "timeout"} (and removes the recipient as a participant)',
    withDriver(
      ctx,
      (driver) =>
        Effect.gen(function* () {
          yield* driver.moderator.silenceAuthorize;
          yield* driver.recipient.requestDispatch({
            conversationId: driver.fixtures.conversationId,
            messageId: freshMessageId(),
            senderAgentId: driver.moderator.agentId,
          });
          // Server-side moderator-response TTL fires after
          // `moderatorTimeoutMs`; recipient sees a synthesized
          // `dispatch/release{deny, reason="timeout"}`.
          const release = yield* driver.recipient.waitForRelease(
            undefined,
            TIMEOUT_RELEASE_WAIT_MS,
          );
          const params = release.params as ReleaseFrameView;
          if (params.verdict.decision !== "deny") {
            return yield* Effect.fail(
              dispatchAdmissionViolation(
                NAME,
                `expected synthesized deny, got ${params.verdict.decision}`,
              ),
            );
          }
          if (
            typeof params.verdict.reason !== "string" ||
            !params.verdict.reason.toLowerCase().includes("timeout")
          ) {
            return yield* Effect.fail(
              dispatchAdmissionViolation(
                NAME,
                `expected reason mentioning "timeout", got: ${String(params.verdict.reason)}`,
              ),
            );
          }
        }),
      { moderatorTimeoutMs: TINY_MODERATOR_TIMEOUT_MS },
    ),
  );
}
