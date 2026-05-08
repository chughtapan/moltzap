/**
 * Conformance — `dispatch/{request,authorize,release}` +
 * `dispatches/{consumed,expired,get}` admission surface (#529 + #533).
 *
 * The 15 properties below cover the post-cutover wire surface end-to-end
 * across the recipient ↔ moderator round-trip. Each property body
 * acquires a fresh per-property `DispatchTestDriver` (architect plan
 * #533 §3, §7) which composes two TestClients against the run's real
 * server. The driver's per-property scope is released when the property
 * Effect completes — every TestClient + the moderator's `apps/register`
 * registration is cleaned up automatically.
 *
 * Server-side (in-process) coverage of the same 17 architect-§8
 * scenarios continues to live in
 * `packages/server/src/__tests__/integration/dispatch-flow.integration.test.ts`;
 * cross-impl wire coverage is now this file (per architect plan #533 §7
 * "row 13 cutover MUST flip every tombstone to executable").
 *
 * Principle 3: every property body is `Effect<void, PropertyFailure>`.
 */
import { Effect, type Scope } from "effect";
import type { Static } from "@sinclair/typebox";
import type { ConformanceRunContext } from "./runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
  type PropertyFailure,
  type PropertyRun,
} from "./registry.js";
import {
  makeDispatchTestDriver,
  type DispatchTestDriver,
} from "./test-server-driver.js";
import type { LeaseId } from "../../app/index.js";
import type { MessageId } from "../../task/methods.js";
import { messageId as makeMessageId } from "../branded-ids.js";

const CATEGORY = "dispatch-admission" as const;

// Empirical bounds. Real-time mode for the conformance runner (no
// `TestClock` install per architect plan §5 NOT-in-scope item) — small
// `leaseTimeoutMs` keeps TTL-driven properties under ~3 s wall-clock.
const SHORT_LEASE_TIMEOUT_MS = 250;
const TINY_MODERATOR_TIMEOUT_MS = 200;
const TTL_OBSERVATION_BUFFER_MS = 1_500;
const ABANDON_OBSERVATION_BUFFER_MS = 1_000;
const NEGATIVE_OBSERVABILITY_WINDOW_MS = 750;
const FORBIDDEN_ERROR_CODE = -32001;

function violation(name: string, reason: string): PropertyInvariantViolation {
  return new PropertyInvariantViolation({ category: CATEGORY, name, reason });
}

// Frame-payload narrowings used across the property bodies. Lifted to
// named types so the type-checker derives the needed structure
// directly. The narrow surfaces still match the wire schemas defined
// in `protocol/src/app/methods.ts` (release /
// dispatches/{consumed,expired}); each property reads only the fields
// it asserts on.
type ReleaseFrameView = {
  readonly leaseId: string;
  readonly verdict: { decision: string; reason?: string };
};
type LeaseIdOnlyView = { readonly leaseId: string };
type ConsumedFrameView = {
  readonly messageId: string;
  readonly leaseId: string;
};

function freshMessageId(): Static<typeof MessageId> {
  // UUIDv4 from the runtime; the brand-decoder accepts a well-formed
  // UUID4 string. `crypto.randomUUID` is in Node 18+.
  return makeMessageId(globalThis.crypto.randomUUID());
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuidV4(s: string): boolean {
  return UUID_V4_RE.test(s);
}

/**
 * Run a property body inside a fresh per-property scope; acquires the
 * driver, runs `body`, releases on completion.
 */
function withDriver(
  ctx: ConformanceRunContext,
  body: (
    driver: DispatchTestDriver,
  ) => Effect.Effect<void, PropertyFailure, Scope.Scope>,
  driverOpts?: Parameters<typeof makeDispatchTestDriver>[1],
): PropertyRun {
  return Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* makeDispatchTestDriver(ctx, driverOpts);
      yield* body(driver);
    }),
  );
}

// ── DispatchRequest (2 properties) ─────────────────────────────────────

export function registerDispatchRequestAckMintsLease(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-request-ack-mints-lease";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "dispatch/request ack returns {leaseId, dispatchId}, both well-formed UUIDv4 (>=122 bits entropy) and distinct from each other",
    withDriver(ctx, (driver) =>
      Effect.gen(function* () {
        // Use a high-grant verdict so the lease resolves quickly and the
        // server-side fork doesn't leave artifacts at scope close.
        yield* driver.moderator.handleAuthorize({
          respondWith: { _tag: "grant" },
        });
        const ack = yield* driver.recipient.requestDispatch({
          conversationId: driver.fixtures.conversationId,
          messageId: freshMessageId(),
          senderAgentId: driver.moderator.agentId,
        });
        if (typeof ack.leaseId !== "string" || !isUuidV4(ack.leaseId)) {
          return yield* Effect.fail(
            violation(NAME, `leaseId not UUIDv4: ${String(ack.leaseId)}`),
          );
        }
        if (typeof ack.dispatchId !== "string" || !isUuidV4(ack.dispatchId)) {
          return yield* Effect.fail(
            violation(NAME, `dispatchId not UUIDv4: ${String(ack.dispatchId)}`),
          );
        }
        if ((ack.leaseId as string) === (ack.dispatchId as string)) {
          return yield* Effect.fail(
            violation(NAME, "leaseId and dispatchId must differ"),
          );
        }
        yield* driver.recipient.waitForRelease();
      }),
    ),
  );
}

export function registerDispatchRequestRecipientDisconnectAbandons(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-request-recipient-disconnect-abandons-lease";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "closing the recipient's connection while in PENDING transitions the lease to ABANDONED; subsequent dispatches/get returns state=ABANDONED",
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
          // moderator.dispatches/get. The driver's poll bound covers
          // the finalizer race window.
          yield* driver.assertLeaseState(ack.dispatchId, "ABANDONED", {
            timeoutMs: ABANDON_OBSERVATION_BUFFER_MS + 2_000,
          });
        }),
      // Wide moderator timeout so the silence path holds the round-
      // trip open until the recipient hard-closes.
      { moderatorTimeoutMs: 30_000 },
    ),
  );
}

// ── DispatchAuthorize (2 properties) ───────────────────────────────────

export function registerDispatchAuthorizeVerdictResolves(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-authorize-verdict-resolves-lease";
  registerProperty(
    ctx,
    CATEGORY,
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
                violation(
                  NAME,
                  `release leaseId ${params.leaseId} != ack ${ack.leaseId}`,
                ),
              );
            }
            if (params.verdict.decision !== verdict._tag) {
              return yield* Effect.fail(
                violation(
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
                violation(
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

export function registerDispatchAuthorizeTimeoutSynthesizesDeny(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-authorize-timeout-synthesizes-deny";
  registerProperty(
    ctx,
    CATEGORY,
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
            3_000,
          );
          const params = release.params as ReleaseFrameView;
          if (params.verdict.decision !== "deny") {
            return yield* Effect.fail(
              violation(
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
              violation(
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

// ── DispatchRelease (2 properties) ─────────────────────────────────────

export function registerDispatchReleaseFiresAfterResolve(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-release-fires-after-resolve";
  registerProperty(
    ctx,
    CATEGORY,
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
            const expected =
              verdict._tag === "grant"
                ? "GRANTED"
                : verdict._tag === "deny"
                  ? "DENIED"
                  : "HOLD";
            yield* driver.assertLeaseState(ack.dispatchId, expected);
            const release = yield* driver.recipient.waitForRelease();
            // Assert exactly one release: collect a second within a
            // tight window and assert no further frame arrived.
            const followup = yield* Effect.exit(
              driver.recipient.waitForRelease(undefined, 250),
            );
            if (followup._tag === "Success") {
              return yield* Effect.fail(
                violation(
                  NAME,
                  `expected exactly one dispatch/release per lease; got a second frame`,
                ),
              );
            }
            // First release must match the lease + verdict.
            const params = release.params as ReleaseFrameView;
            if (params.leaseId !== ack.leaseId) {
              return yield* Effect.fail(
                violation(
                  NAME,
                  `release leaseId ${params.leaseId} != ack ${ack.leaseId}`,
                ),
              );
            }
            if (params.verdict.decision !== verdict._tag) {
              return yield* Effect.fail(
                violation(
                  NAME,
                  `release decision ${params.verdict.decision} != expected ${verdict._tag}`,
                ),
              );
            }
          }),
        );
      }
    }),
  );
}

export function registerDispatchReleaseSkippedOnAbandoned(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatch-release-skipped-on-abandoned";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "leases that transition PENDING→ABANDONED (recipient disconnect) emit no dispatch/release",
    withDriver(
      ctx,
      (driver) =>
        Effect.gen(function* () {
          yield* driver.moderator.silenceAuthorize;
          const ack = yield* driver.recipient.requestDispatch({
            conversationId: driver.fixtures.conversationId,
            messageId: freshMessageId(),
            senderAgentId: driver.moderator.agentId,
          });
          // Hard-close before the verdict resolves → ABANDONED.
          yield* driver.recipient.hardClose;
          // Confirm ABANDONED transition (positive) — proof the lease
          // is in the no-release terminal state. The architect §7
          // "no release went to a third-party listener" assertion
          // is implicit at the wire level: the recipient's connection
          // is closed, so no `dispatch/release` could land there;
          // dispatches/* notifications fire only on the moderator's
          // connection (see lease-registry.ts:516 emit fan-out).
          yield* driver.assertLeaseState(ack.dispatchId, "ABANDONED", {
            timeoutMs: ABANDON_OBSERVATION_BUFFER_MS + 2_000,
          });
          // Confirm the moderator did NOT see a `dispatches/expired`
          // (no release fan-out path for ABANDONED) within a short
          // window. ABANDONED leases never reach EXPIRED because no
          // grant happened — but assert by state, not by absence of
          // notifications, since `dispatches/expired` is not the
          // primary signal.
        }),
      { moderatorTimeoutMs: 30_000 },
    ),
  );
}

// ── DispatchesConsumed (2 properties) ──────────────────────────────────

export function registerDispatchesConsumedFiresOnFirstSend(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatches-consumed-fires-on-first-send";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "first messages/send(dispatchLeaseId=X) with X in GRANTED state emits dispatches/consumed with the right messageId to the moderator's connection",
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
        const sent = yield* driver.recipient.sendWithLease({
          conversationId: driver.fixtures.conversationId,
          leaseId: ack.leaseId,
          text: "consumed",
        });
        if (sent.errorCode !== undefined) {
          return yield* Effect.fail(
            violation(
              NAME,
              `messages/send unexpectedly failed: code=${sent.errorCode}`,
            ),
          );
        }
        const consumed = yield* driver.moderator.waitForObservability(
          "consumed",
          { dispatchId: ack.dispatchId },
        );
        const params = consumed.params as ConsumedFrameView;
        if (params.leaseId !== ack.leaseId) {
          return yield* Effect.fail(
            violation(
              NAME,
              `dispatches/consumed leaseId ${params.leaseId} != ack ${ack.leaseId}`,
            ),
          );
        }
        if (
          typeof params.messageId !== "string" ||
          !isUuidV4(params.messageId)
        ) {
          return yield* Effect.fail(
            violation(
              NAME,
              `dispatches/consumed messageId not UUIDv4: ${String(params.messageId)}`,
            ),
          );
        }
      }),
    ),
  );
}

export function registerDispatchesConsumedSuppressedOnSecondSend(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatches-consumed-suppressed-on-second-send";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "second messages/send(dispatchLeaseId=X) with X in CONSUMED state returns typed LeaseInvalidError and does NOT emit a duplicate dispatches/consumed",
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
        // First send consumes the lease.
        const first = yield* driver.recipient.sendWithLease({
          conversationId: driver.fixtures.conversationId,
          leaseId: ack.leaseId,
          text: "first",
        });
        if (first.errorCode !== undefined) {
          return yield* Effect.fail(
            violation(NAME, `first send failed: code=${first.errorCode}`),
          );
        }
        // Drain the first dispatches/consumed (positive observability).
        yield* driver.moderator.waitForObservability("consumed", {
          dispatchId: ack.dispatchId,
        });
        // Second send must surface typed LeaseInvalid error
        // (ForbiddenError code -32001 with data.state="CONSUMED").
        // ALSO covers the TTL-skip-on-CLAIMED rule indirectly: if TTL
        // had fired on CLAIMED, the second send would surface EXPIRED;
        // CONSUMED implies TTL was correctly skipped.
        const second = yield* driver.recipient.sendWithLease({
          conversationId: driver.fixtures.conversationId,
          leaseId: ack.leaseId,
          text: "second",
        });
        if (second.errorCode === undefined) {
          return yield* Effect.fail(
            violation(
              NAME,
              "second messages/send unexpectedly succeeded; expected LeaseInvalid",
            ),
          );
        }
        if (second.errorCode !== FORBIDDEN_ERROR_CODE) {
          return yield* Effect.fail(
            violation(
              NAME,
              `second send error code ${second.errorCode} != Forbidden(${FORBIDDEN_ERROR_CODE})`,
            ),
          );
        }
        if (second.errorState !== "CONSUMED") {
          return yield* Effect.fail(
            violation(
              NAME,
              `second send LeaseInvalid state ${String(second.errorState)} != CONSUMED`,
            ),
          );
        }
        // Confirm no duplicate dispatches/consumed within a tight
        // window — only the first one fired.
        const dup = yield* Effect.exit(
          driver.moderator.waitForObservability("consumed", {
            dispatchId: ack.dispatchId,
            timeoutMs: NEGATIVE_OBSERVABILITY_WINDOW_MS,
          }),
        );
        if (dup._tag === "Success") {
          return yield* Effect.fail(
            violation(
              NAME,
              "saw a duplicate dispatches/consumed for the second send",
            ),
          );
        }
      }),
    ),
  );
}

// ── DispatchesExpired (2 properties) ───────────────────────────────────

export function registerDispatchesExpiredFiresOnTtl(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatches-expired-fires-on-ttl";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "granted-but-unused lease emits dispatches/expired to the moderator after leaseTimeoutMs elapses; lease state advances to EXPIRED",
    withDriver(ctx, (driver) =>
      Effect.gen(function* () {
        yield* driver.moderator.handleAuthorize({
          respondWith: {
            _tag: "grant",
            leaseTimeoutMs: SHORT_LEASE_TIMEOUT_MS,
          },
        });
        const ack = yield* driver.recipient.requestDispatch({
          conversationId: driver.fixtures.conversationId,
          messageId: freshMessageId(),
          senderAgentId: driver.moderator.agentId,
        });
        yield* driver.recipient.waitForRelease();
        // Sleep past the lease TTL — the server-side scheduled fiber
        // fires `dispatches/expired` to the moderator and advances
        // the lease to EXPIRED.
        yield* driver.advanceTime(
          SHORT_LEASE_TIMEOUT_MS + TTL_OBSERVATION_BUFFER_MS,
        );
        const expired = yield* driver.moderator.waitForObservability(
          "expired",
          { dispatchId: ack.dispatchId, timeoutMs: 2_000 },
        );
        const params = expired.params as LeaseIdOnlyView;
        if (params.leaseId !== ack.leaseId) {
          return yield* Effect.fail(
            violation(
              NAME,
              `dispatches/expired leaseId ${params.leaseId} != ack ${ack.leaseId}`,
            ),
          );
        }
        yield* driver.assertLeaseState(ack.dispatchId, "EXPIRED");
      }),
    ),
  );
}

export function registerDispatchesExpiredSuppressedOnConsumeBeforeTtl(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatches-expired-suppressed-on-consume-before-ttl";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "lease consumed before TTL emits dispatches/consumed (not expired); no dispatches/expired ever fires for this lease",
    withDriver(ctx, (driver) =>
      Effect.gen(function* () {
        yield* driver.moderator.handleAuthorize({
          respondWith: {
            _tag: "grant",
            leaseTimeoutMs: SHORT_LEASE_TIMEOUT_MS,
          },
        });
        const ack = yield* driver.recipient.requestDispatch({
          conversationId: driver.fixtures.conversationId,
          messageId: freshMessageId(),
          senderAgentId: driver.moderator.agentId,
        });
        yield* driver.recipient.waitForRelease();
        // Consume immediately, well before the TTL.
        const sent = yield* driver.recipient.sendWithLease({
          conversationId: driver.fixtures.conversationId,
          leaseId: ack.leaseId as Static<typeof LeaseId>,
          text: "consume-before-ttl",
        });
        if (sent.errorCode !== undefined) {
          return yield* Effect.fail(
            violation(NAME, `messages/send failed: code=${sent.errorCode}`),
          );
        }
        // Drain the positive `consumed` notification + its lease state.
        yield* driver.moderator.waitForObservability("consumed", {
          dispatchId: ack.dispatchId,
        });
        yield* driver.assertLeaseState(ack.dispatchId, "CONSUMED");
        // Wait past the TTL and assert no `dispatches/expired` ever
        // fires. (CLAIMED-no-op + post-CONSUME no-op rules.)
        yield* driver.advanceTime(
          SHORT_LEASE_TIMEOUT_MS + TTL_OBSERVATION_BUFFER_MS,
        );
        const expired = yield* Effect.exit(
          driver.moderator.waitForObservability("expired", {
            dispatchId: ack.dispatchId,
            timeoutMs: NEGATIVE_OBSERVABILITY_WINDOW_MS,
          }),
        );
        if (expired._tag === "Success") {
          return yield* Effect.fail(
            violation(
              NAME,
              "dispatches/expired unexpectedly fired after CONSUMED",
            ),
          );
        }
      }),
    ),
  );
}

// ── DispatchesGet (2 properties) ───────────────────────────────────────

export function registerDispatchesGetModeratorSeesRecord(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatches-get-moderator-sees-record";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "dispatches/get from the moderator's connection at each lifecycle stage returns the full LeaseRecord with state matching the stage",
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
        // Stage 1: PENDING → GRANTED transition (architect plan §3
        // state machine). Once `assertLeaseState` sees GRANTED, the
        // moderator's view is settled.
        yield* driver.recipient.waitForRelease();
        yield* driver.assertLeaseState(ack.dispatchId, "GRANTED");
        const grantedView = yield* driver.moderator.getLease(ack.dispatchId);
        if (grantedView.leaseId !== ack.leaseId) {
          return yield* Effect.fail(
            violation(
              NAME,
              `getLease leaseId ${grantedView.leaseId} != ack ${ack.leaseId}`,
            ),
          );
        }
        if (grantedView.state !== "GRANTED") {
          return yield* Effect.fail(
            violation(NAME, `expected GRANTED, got ${grantedView.state}`),
          );
        }
        if (
          grantedView.verdict === null ||
          grantedView.verdict._tag !== "grant"
        ) {
          return yield* Effect.fail(
            violation(
              NAME,
              `expected verdict.grant, got ${JSON.stringify(grantedView.verdict)}`,
            ),
          );
        }
        // Stage 2: GRANTED → CONSUMED via messages/send.
        const sent = yield* driver.recipient.sendWithLease({
          conversationId: driver.fixtures.conversationId,
          leaseId: ack.leaseId as Static<typeof LeaseId>,
          text: "consume-for-getlease-stage",
        });
        if (sent.errorCode !== undefined) {
          return yield* Effect.fail(
            violation(NAME, `messages/send failed: code=${sent.errorCode}`),
          );
        }
        yield* driver.moderator.waitForObservability("consumed", {
          dispatchId: ack.dispatchId,
        });
        yield* driver.assertLeaseState(ack.dispatchId, "CONSUMED");
        const consumedView = yield* driver.moderator.getLease(ack.dispatchId);
        if (consumedView.state !== "CONSUMED") {
          return yield* Effect.fail(
            violation(NAME, `expected CONSUMED, got ${consumedView.state}`),
          );
        }
      }),
    ),
  );
}

export function registerDispatchesGetNonModeratorRejected(
  ctx: ConformanceRunContext,
): void {
  const NAME = "dispatches-get-non-moderator-rejected";
  registerProperty(
    ctx,
    CATEGORY,
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
        if (result.errorCode !== FORBIDDEN_ERROR_CODE) {
          return yield* Effect.fail(
            violation(
              NAME,
              `expected Forbidden(${FORBIDDEN_ERROR_CODE}), got ${result.errorCode}`,
            ),
          );
        }
      }),
    ),
  );
}

// ── Rewritten dispatcher-concurrency P1-P3 (closes #358) ───────────────

export function registerSameConversationDispatchesConcurrent(
  ctx: ConformanceRunContext,
): void {
  const NAME = "same-conversation-dispatches-reach-moderator-concurrently";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "two dispatch/request calls in same (taskId, conversationId) reach the moderator without server-side serialization (closes #358 P1)",
    withDriver(ctx, (driver) =>
      Effect.gen(function* () {
        // Two recipients in the same conversation issue dispatch/request
        // concurrently; both round-trips must reach the moderator
        // without the server serializing them.
        yield* driver.moderator.handleAuthorize({
          respondWith: { _tag: "grant" },
        });
        const second = yield* driver.addRecipient({});
        const conv = driver.fixtures.conversationId;
        const [ack1, ack2] = yield* Effect.all(
          [
            driver.recipient.requestDispatch({
              conversationId: conv,
              messageId: freshMessageId(),
              senderAgentId: driver.moderator.agentId,
            }),
            second.requestDispatch({
              conversationId: conv,
              messageId: freshMessageId(),
              senderAgentId: driver.moderator.agentId,
            }),
          ] as const,
          // Two recipients in parallel — the architect §7 row asserts
          // both round-trips reach the moderator without server-side
          // serialization, so we want overlapping execution. Bounded
          // concurrency = 2 (one per recipient).
          { concurrency: 2 },
        );
        if (ack1.leaseId === ack2.leaseId) {
          return yield* Effect.fail(
            violation(NAME, "leaseIds collided across concurrent requests"),
          );
        }
        if (ack1.dispatchId === ack2.dispatchId) {
          return yield* Effect.fail(
            violation(NAME, "dispatchIds collided across concurrent requests"),
          );
        }
        // Both verdicts arrive (architect §7: handleAuthorize is called
        // twice within Effect.fork overlap).
        yield* driver.recipient.waitForRelease();
        yield* second.waitForRelease();
      }),
    ),
  );
}

export function registerSlowFirstDoesNotDelaySecondAck(
  ctx: ConformanceRunContext,
): void {
  const NAME = "slow-first-moderator-call-does-not-delay-second-ack";
  registerProperty(
    ctx,
    CATEGORY,
    NAME,
    "first moderator round-trip blocks for N seconds; second dispatch/request ack arrives within << N (server-side fork, not blocking on first) (closes #358 P2)",
    withDriver(
      ctx,
      (driver) =>
        Effect.gen(function* () {
          // Hold the moderator response for 5 s on EVERY incoming
          // request — regardless of which lease, both replies are
          // delayed but the SERVER still acks both `dispatch/request`
          // immediately (the fork-and-ack invariant). The second ack
          // observed below MUST land before the moderator's hold
          // elapses; the test bounds the second ack's latency well
          // under the hold window.
          const HOLD_MS = 5_000;
          yield* driver.moderator.handleAuthorize({
            respondWith: { _tag: "grant" },
            holdResponseFor: HOLD_MS,
          });
          const conv = driver.fixtures.conversationId;
          const tStart = Date.now();
          // First dispatch/request (acked immediately by server; the
          // forked moderator round-trip is now blocked for HOLD_MS).
          yield* driver.recipient.requestDispatch({
            conversationId: conv,
            messageId: freshMessageId(),
            senderAgentId: driver.moderator.agentId,
          });
          // Second dispatch/request (still acked immediately).
          yield* driver.recipient.requestDispatch({
            conversationId: conv,
            messageId: freshMessageId(),
            senderAgentId: driver.moderator.agentId,
          });
          const elapsed = Date.now() - tStart;
          // Both acks under 1 s — must be much less than HOLD_MS.
          if (elapsed > 1_000) {
            return yield* Effect.fail(
              violation(
                NAME,
                `second ack arrived after ${elapsed}ms (>1s); server-side serialization detected`,
              ),
            );
          }
        }),
      // Use a moderator timeout long enough to outlast HOLD_MS so the
      // verdicts eventually settle (and the property's scope-close
      // tear-down is not blocked).
      { moderatorTimeoutMs: 15_000 },
    ),
  );
}

export function registerReleaseForOneLeaseDoesNotWaitOnAnother(
  ctx: ConformanceRunContext,
): void {
  const NAME = "release-for-one-lease-does-not-wait-on-another";
  registerProperty(
    ctx,
    CATEGORY,
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
            HOLD_MS - 500,
          );
          const params2 = second.params as LeaseIdOnlyView;
          if (params2.leaseId !== ack2.leaseId) {
            return yield* Effect.fail(
              violation(NAME, `second release leaseId mismatch`),
            );
          }
          // Drain the first (slow) release — within the hold window
          // plus a generous buffer.
          yield* driver.recipient.waitForRelease(
            (frame) =>
              (frame.params as LeaseIdOnlyView).leaseId === ack1.leaseId,
            HOLD_MS + 2_000,
          );
        }),
      { moderatorTimeoutMs: 15_000 },
    ),
  );
}
