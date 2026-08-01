/**
 * @file Public barrel for app-layer conformance properties.
 *
 * App-layer conformance properties.
 *
 * Dispatch / lease / app-callback invariants — the 14
 * `dispatch-admission` properties (request / authorize / release /
 * dispatch-lease-consumed / dispatch-lease-expired / dispatch-lease-get / slow-first
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
import { registerDispatchLeaseConsumedFiresOnFirstSend } from "./dispatch-lease-consumed-fires-on-first-send.js";
import { registerDispatchLeaseConsumedSuppressedOnSecondSend } from "./dispatch-lease-consumed-suppressed-on-second.js";
import { registerDispatchLeaseExpiredFiresOnTtl } from "./dispatch-lease-expired-fires-on-ttl.js";
import { registerDispatchLeaseExpiredSuppressedOnConsumeBeforeTtl } from "./dispatch-lease-expired-suppressed-on-consume.js";
import { registerDispatchLeaseGetModeratorSeesRecord } from "./dispatch-lease-get-moderator-sees.js";
import { registerSameConversationDispatchRequestsConcurrent } from "./same-conv-dispatch-requests-concurrent.js";
import { registerSlowFirstDoesNotDelaySecondAck } from "./slow-first-does-not-delay-second-ack.js";
import { registerReleaseForOneLeaseDoesNotWaitOnAnother } from "./release-for-one-lease-does-not-wait.js";
import { registerAppDisconnectFailPolicy } from "./app-disconnect-fail-policy.js";
import { registerIdempotence } from "./idempotence.js";

export {
  registerAppDisconnectFailPolicy,
  registerDispatchAuthorizeTimeoutSynthesizesDeny,
  registerDispatchAuthorizeVerdictResolves,
  registerDispatchLeaseConsumedFiresOnFirstSend,
  registerDispatchLeaseConsumedSuppressedOnSecondSend,
  registerDispatchLeaseExpiredFiresOnTtl,
  registerDispatchLeaseExpiredSuppressedOnConsumeBeforeTtl,
  registerDispatchLeaseGetModeratorSeesRecord,
  registerDispatchReleaseFiresAfterResolve,
  registerDispatchReleaseSkippedOnAbandoned,
  registerDispatchRequestAckMintsLease,
  registerDispatchRequestRecipientDisconnectAbandons,
  registerIdempotence,
  registerReleaseForOneLeaseDoesNotWaitOnAnother,
  registerSameConversationDispatchRequestsConcurrent,
  registerSlowFirstDoesNotDelaySecondAck,
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
  registerDispatchLeaseConsumedFiresOnFirstSend,
  registerDispatchLeaseConsumedSuppressedOnSecondSend,
  registerDispatchLeaseExpiredFiresOnTtl,
  registerDispatchLeaseExpiredSuppressedOnConsumeBeforeTtl,
  registerDispatchLeaseGetModeratorSeesRecord,
  registerSameConversationDispatchRequestsConcurrent,
  registerSlowFirstDoesNotDelaySecondAck,
  registerReleaseForOneLeaseDoesNotWaitOnAnother,
  registerAppDisconnectFailPolicy,
  registerIdempotence,
];
