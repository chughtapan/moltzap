/**
 * @file Public barrel for app-layer conformance properties.
 *
 * App-layer conformance properties.
 *
 * Dispatch / lease / app-callback invariants — the 14
 * `dispatch-admission` properties (request / authorize / release /
 * dispatches-consumed / dispatches-expired / dispatches-get / slow-first
 * / same-conv-concurrent / release-for-one-lease) plus app-disconnect
 * fail-policy and idempotence.
 *
 * Each `register*` lives in its own file. The `dispatch-admission`
 * properties draw on the cross-impl driver in `app/_driver.ts`.
 */
import type { ConformanceRunContext } from "../_shared/runner.js";

import { registerDispatchRequestAckMintsLease } from "./dispatch-request-ack.js";
import { registerDispatchRequestRecipientDisconnectAbandons } from "./dispatch-request-recipient-disconnect.js";
import { registerDispatchAuthorizeVerdictResolves } from "./dispatch-authorize-verdict.js";
import { registerDispatchAuthorizeTimeoutSynthesizesDeny } from "./dispatch-authorize-timeout.js";
import { registerDispatchReleaseFiresAfterResolve } from "./dispatch-release-after-resolve.js";
import { registerDispatchReleaseSkippedOnAbandoned } from "./dispatch-release-skipped-on-abandoned.js";
import { registerDispatchesConsumedFiresOnFirstSend } from "./dispatches-consumed-fires-on-first-send.js";
import { registerDispatchesConsumedSuppressedOnSecondSend } from "./dispatches-consumed-suppressed-on-second.js";
import { registerDispatchesExpiredFiresOnTtl } from "./dispatches-expired-fires-on-ttl.js";
import { registerDispatchesExpiredSuppressedOnConsumeBeforeTtl } from "./dispatches-expired-suppressed-on-consume.js";
import { registerDispatchesGetModeratorSeesRecord } from "./dispatches-get-moderator-sees.js";
import { registerSameConversationDispatchesConcurrent } from "./same-conv-dispatches-concurrent.js";
import { registerSlowFirstDoesNotDelaySecondAck } from "./slow-first-does-not-delay-second-ack.js";
import { registerReleaseForOneLeaseDoesNotWaitOnAnother } from "./release-for-one-lease-does-not-wait.js";
import { registerAppDisconnectFailPolicy } from "./app-disconnect-fail-policy.js";
import { registerIdempotence } from "./idempotence.js";

export {
  registerDispatchRequestAckMintsLease,
  registerDispatchRequestRecipientDisconnectAbandons,
  registerDispatchAuthorizeVerdictResolves,
  registerDispatchAuthorizeTimeoutSynthesizesDeny,
  registerDispatchReleaseFiresAfterResolve,
  registerDispatchReleaseSkippedOnAbandoned,
  registerDispatchesConsumedFiresOnFirstSend,
  registerDispatchesConsumedSuppressedOnSecondSend,
  registerDispatchesExpiredFiresOnTtl,
  registerDispatchesExpiredSuppressedOnConsumeBeforeTtl,
  registerDispatchesGetModeratorSeesRecord,
  registerSameConversationDispatchesConcurrent,
  registerSlowFirstDoesNotDelaySecondAck,
  registerReleaseForOneLeaseDoesNotWaitOnAnother,
  registerAppDisconnectFailPolicy,
  registerIdempotence,
};

/**
 * All app-layer property registrars: dispatch-admission registrars first,
 * then the cross-category registrars (boundary unavailable,
 * rpc-semantics idempotence).
 */
export const APP_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerDispatchRequestAckMintsLease,
  registerDispatchRequestRecipientDisconnectAbandons,
  registerDispatchAuthorizeVerdictResolves,
  registerDispatchAuthorizeTimeoutSynthesizesDeny,
  registerDispatchReleaseFiresAfterResolve,
  registerDispatchReleaseSkippedOnAbandoned,
  registerDispatchesConsumedFiresOnFirstSend,
  registerDispatchesConsumedSuppressedOnSecondSend,
  registerDispatchesExpiredFiresOnTtl,
  registerDispatchesExpiredSuppressedOnConsumeBeforeTtl,
  registerDispatchesGetModeratorSeesRecord,
  registerSameConversationDispatchesConcurrent,
  registerSlowFirstDoesNotDelaySecondAck,
  registerReleaseForOneLeaseDoesNotWaitOnAnother,
  registerAppDisconnectFailPolicy,
  registerIdempotence,
];
