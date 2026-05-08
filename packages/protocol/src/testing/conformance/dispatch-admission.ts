/**
 * Conformance — `dispatch/{request,authorize,release}` +
 * `dispatches/{consumed,expired,get}` admission surface (#529).
 *
 * Properties P1-P12 below cover the new wire surface; rewriting P1-P3
 * of the legacy `dispatcher-concurrency.ts` `it.todo` placeholders
 * closes epic issue #358.
 *
 * Status: registered with category `"dispatch-admission"` so the
 * conformance registry's coverage policy enforces them. Today every
 * property registers a tombstone via `PropertyDeferred` because
 * cross-implementation execution requires the conformance `TestServer`
 * to drive both ends of the dispatch round-trip — recipient calls
 * `dispatch/request`; moderator (a separate test client) replies via
 * `dispatch/authorize`. The infrastructure landing tracker is the
 * follow-up to this PR's row 13 cutover.
 *
 * The server-side properties exercise the actual lease registry +
 * forked moderator round-trip + admission flow against the real
 * server in the integration test
 * `packages/server/src/__tests__/integration/dispatch-flow.integration.test.ts`
 * (architect plan §8). When the cross-impl `TestServer` extension
 * lands, the body of each property below moves from `PropertyDeferred`
 * to a real assertion run.
 *
 * Principle 3: every property body is `Effect<void, PropertyFailure>`.
 */
import { Effect } from "effect";
import type { ConformanceRunContext } from "./runner.js";
import { PropertyDeferred, registerProperty } from "./registry.js";

const CATEGORY = "dispatch-admission" as const;

const FOLLOWUP =
  "cross-impl `dispatch/request` driver in TestServer (architect row 11+13 follow-up); server-side coverage lives in dispatch-flow.integration.test.ts";

function deferredProperty(
  ctx: ConformanceRunContext,
  name: string,
  description: string,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    name,
    description,
    Effect.fail(
      new PropertyDeferred({
        category: CATEGORY,
        name,
        followUp: FOLLOWUP,
      }),
    ),
  );
  void ctx;
}

// ── DispatchRequest (2 properties) ─────────────────────────────────────

export function registerDispatchRequestAckMintsLease(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "dispatch-request-ack-mints-lease",
    "dispatch/request ack returns {leaseId, dispatchId}, both well-formed UUIDv4 (>=122 bits entropy) and distinct from each other",
  );
}

export function registerDispatchRequestRecipientDisconnectAbandons(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "dispatch-request-recipient-disconnect-abandons-lease",
    "closing the recipient's connection while in PENDING transitions the lease to ABANDONED; subsequent dispatches/get returns state=ABANDONED",
  );
}

// ── DispatchAuthorize (2 properties) ───────────────────────────────────

export function registerDispatchAuthorizeVerdictResolves(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "dispatch-authorize-verdict-resolves-lease",
    "moderator's {grant|deny|hold} reply causes the server to emit dispatch/release with the matching verdict to the recipient",
  );
}

export function registerDispatchAuthorizeTimeoutSynthesizesDeny(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "dispatch-authorize-timeout-synthesizes-deny",
    'moderator never replies within timeout_ms; server emits dispatch/release{deny, reason: "timeout"} and (separately) participants/removed',
  );
}

// ── DispatchRelease (2 properties) ─────────────────────────────────────

export function registerDispatchReleaseFiresAfterResolve(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "dispatch-release-fires-after-resolve",
    "for every resolved lease (grant/deny/hold), exactly one dispatch/release reaches the recipient",
  );
}

export function registerDispatchReleaseSkippedOnAbandoned(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "dispatch-release-skipped-on-abandoned",
    "leases that transition PENDING→ABANDONED (recipient disconnect) emit no dispatch/release",
  );
}

// ── DispatchesConsumed (2 properties) ──────────────────────────────────

export function registerDispatchesConsumedFiresOnFirstSend(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "dispatches-consumed-fires-on-first-send",
    "first messages/send(dispatchLeaseId=X) with X in GRANTED state emits dispatches/consumed with the right messageId to the moderator's connection",
  );
}

export function registerDispatchesConsumedSuppressedOnSecondSend(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "dispatches-consumed-suppressed-on-second-send",
    "second messages/send(dispatchLeaseId=X) with X in CONSUMED state returns typed LeaseInvalidError and does NOT emit a duplicate dispatches/consumed",
  );
}

// ── DispatchesExpired (2 properties) ───────────────────────────────────

export function registerDispatchesExpiredFiresOnTtl(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "dispatches-expired-fires-on-ttl",
    "granted-but-unused lease emits dispatches/expired to the moderator after leaseTimeoutMs elapses; lease state advances to EXPIRED",
  );
}

export function registerDispatchesExpiredSuppressedOnConsumeBeforeTtl(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "dispatches-expired-suppressed-on-consume-before-ttl",
    "lease consumed before TTL emits dispatches/consumed (not expired); no dispatches/expired ever fires for this lease",
  );
}

// ── DispatchesGet (2 properties) ───────────────────────────────────────

export function registerDispatchesGetModeratorSeesRecord(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "dispatches-get-moderator-sees-record",
    "dispatches/get from the moderator's connection at each lifecycle stage returns the full LeaseRecord with state matching the stage",
  );
}

export function registerDispatchesGetNonModeratorRejected(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "dispatches-get-non-moderator-rejected",
    "dispatches/get from any non-moderator connection (including the recipient) returns typed ForbiddenError",
  );
}

// ── Rewritten dispatcher-concurrency P1-P3 (closes #358) ───────────────

export function registerSameConversationDispatchesConcurrent(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "same-conversation-dispatches-reach-moderator-concurrently",
    "two dispatch/request calls in same (taskId, conversationId) reach the moderator without server-side serialization (closes #358 P1)",
  );
}

export function registerSlowFirstDoesNotDelaySecondAck(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "slow-first-moderator-call-does-not-delay-second-ack",
    "first moderator round-trip blocks for N seconds; second dispatch/request ack arrives within << N (server-side fork, not blocking on first) (closes #358 P2)",
  );
}

export function registerReleaseForOneLeaseDoesNotWaitOnAnother(
  ctx: ConformanceRunContext,
): void {
  deferredProperty(
    ctx,
    "release-for-one-lease-does-not-wait-on-another",
    "emit-time independence of leases (closes #358 P3)",
  );
}
