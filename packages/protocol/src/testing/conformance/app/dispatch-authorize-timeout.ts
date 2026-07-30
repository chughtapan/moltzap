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

/**
 * Registers dispatch authorize timeout synthesizes deny.
 * @param ctx Context for the operation.
 */
export function registerDispatchAuthorizeTimeoutSynthesizesDeny(
  ctx: ConformanceRunContext,
): void {
  const name = "dispatch-authorize-timeout-synthesizes-deny";
  registerProperty(
    ctx,
    DISPATCH_ADMISSION_CATEGORY,
    name,
    'moderator never replies within the hook policy timeoutMs; server emits agent/dispatch/released{deny, reason: "timeout"} (and removes the recipient as a participant)',
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
          // `agent/dispatch/released{deny, reason="timeout"}`.
          const release = yield* driver.recipient.waitForRelease(
            undefined,
            TIMEOUT_RELEASE_WAIT_MS,
          );
          const params =
            /* Safe because waitForRelease filters for the released-notification descriptor. */ release.params as ReleaseFrameView;
          if (params.verdict.decision !== "deny") {
            return yield* dispatchAdmissionViolation(
              name,
              `expected synthesized deny, got ${params.verdict.decision}`,
            );
          }
          if (
            typeof params.verdict.reason !== "string" ||
            !params.verdict.reason.toLowerCase().includes("timeout")
          ) {
            return yield* dispatchAdmissionViolation(
              name,
              `expected reason mentioning "timeout", got: ${String(params.verdict.reason)}`,
            );
          }
        }),
      { moderatorTimeoutMs: TINY_MODERATOR_TIMEOUT_MS },
    ).pipe(Effect.withSpan("registerDispatchAuthorizeTimeoutSynthesizesDeny")),
  );
}
