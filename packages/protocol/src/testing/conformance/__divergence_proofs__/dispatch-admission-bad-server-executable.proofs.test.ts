/**
 * Known-bad-server divergence proofs for the 15 dispatch-admission
 * conformance registrars in `app/dispatch-*.ts` /
 * `app/dispatches-*.ts` / `app/same-conv-*.ts` /
 * `app/slow-first-*.ts` / `app/release-for-one-*.ts`.
 *
 * Each proof spins up a deliberately-misbehaving WebSocket server that
 * violates ONE named invariant of one registrar, drives a single
 * property run via `runExpectingFailure`, and asserts the failure tag.
 *
 * Mirrors the shape of `server-executable.proofs.test.ts`, but with a
 * heavier server-side state machine: the dispatch admission flow needs
 * cross-connection coordination (recipient → moderator round-trip via
 * S→C `dispatch/authorize`, then S→recipient `dispatch/release`), plus
 * a per-lease state machine the property bodies poll via
 * `dispatches/get`. The harness keeps that state in a single
 * `Ref&lt;ServerState>` shared across every connection on a server
 * instance; per-connection writers register on connect and unregister
 * on close.
 *
 * Bad-server behaviors (one per registrar) are encoded as a
 * `BadServerBehavior` discriminated union; the inbound-frame handler
 * picks the misbehavior at the inflection point — wire ack vs.
 * synthesized release vs. consumed-emit vs. dispatches/get response —
 * so each property body's named assertion path triggers without the
 * bad server having to emulate the whole real-server surface.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as fc from "fast-check";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
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
  registerDispatchesGetNonModeratorRejected,
  registerSameConversationDispatchesConcurrent,
  registerSlowFirstDoesNotDelaySecondAck,
  registerReleaseForOneLeaseDoesNotWaitOnAnother,
} from "../app/index.js";
import { expectInvariant } from "./executable-proof-helpers.js";
import type { BadServerBehavior } from "./dispatch-admission-bad-server-model.js";
import { runSingleDispatchProof } from "./dispatch-admission-bad-server-harness.js";

// ── Top-level vitest entries ─────────────────────────────────────────

interface DispatchProofCase {
  readonly title: string;
  readonly register: (ctx: ConformanceRunContext) => void;
  readonly behavior: BadServerBehavior;
  readonly propertyName: string;
  readonly timeoutMs: number;
}

const DEFAULT_PROOF_TIMEOUT_MS = 20_000;
const SLOW_PROOF_TIMEOUT_MS = 30_000;

const DISPATCH_PROOF_CASES: ReadonlyArray<DispatchProofCase> = [
  {
    title:
      "registerDispatchRequestAckMintsLease fails when ack leaseId is not UUIDv4",
    register: registerDispatchRequestAckMintsLease,
    behavior: "ack-non-uuidv4-leaseid",
    propertyName: "dispatch-request-ack-mints-lease",
    timeoutMs: DEFAULT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerDispatchRequestRecipientDisconnectAbandons fails when server keeps lease PENDING after recipient disconnect",
    register: registerDispatchRequestRecipientDisconnectAbandons,
    behavior: "no-abandon-on-disconnect",
    propertyName: "driver.assertLeaseState",
    timeoutMs: DEFAULT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerDispatchAuthorizeVerdictResolves fails when server emits release with mismatched decision",
    register: registerDispatchAuthorizeVerdictResolves,
    behavior: "release-decision-mismatch",
    propertyName: "dispatch-authorize-verdict-resolves-lease",
    timeoutMs: DEFAULT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerDispatchAuthorizeTimeoutSynthesizesDeny fails when synthesized release carries decision=grant",
    register: registerDispatchAuthorizeTimeoutSynthesizesDeny,
    behavior: "synthesize-grant-on-timeout",
    propertyName: "dispatch-authorize-timeout-synthesizes-deny",
    timeoutMs: DEFAULT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerDispatchReleaseFiresAfterResolve fails when server emits release twice for one lease",
    register: registerDispatchReleaseFiresAfterResolve,
    behavior: "release-fires-twice",
    propertyName: "dispatch-release-fires-after-resolve",
    timeoutMs: DEFAULT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerDispatchReleaseSkippedOnAbandoned fails when server keeps lease PENDING after recipient disconnect",
    register: registerDispatchReleaseSkippedOnAbandoned,
    behavior: "no-abandon-on-disconnect",
    propertyName: "driver.assertLeaseState",
    timeoutMs: DEFAULT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerDispatchesConsumedFiresOnFirstSend fails when dispatches/consumed reports a mismatched leaseId",
    register: registerDispatchesConsumedFiresOnFirstSend,
    behavior: "consumed-leaseid-mismatch",
    propertyName: "dispatches-consumed-fires-on-first-send",
    timeoutMs: DEFAULT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerDispatchesConsumedSuppressedOnSecondSend fails when dispatches/consumed fires again on the second send",
    register: registerDispatchesConsumedSuppressedOnSecondSend,
    behavior: "consumed-fires-on-second-send",
    propertyName: "dispatches-consumed-suppressed-on-second-send",
    timeoutMs: DEFAULT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerDispatchesExpiredFiresOnTtl fails when dispatches/expired reports a mismatched leaseId",
    register: registerDispatchesExpiredFiresOnTtl,
    behavior: "expired-leaseid-mismatch",
    propertyName: "dispatches-expired-fires-on-ttl",
    timeoutMs: DEFAULT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerDispatchesExpiredSuppressedOnConsumeBeforeTtl fails when dispatches/expired fires after CONSUMED",
    register: registerDispatchesExpiredSuppressedOnConsumeBeforeTtl,
    behavior: "expired-fires-after-consume",
    propertyName: "dispatches-expired-suppressed-on-consume-before-ttl",
    timeoutMs: DEFAULT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerDispatchesGetModeratorSeesRecord fails when dispatches/get returns a mismatched leaseId",
    register: registerDispatchesGetModeratorSeesRecord,
    behavior: "getlease-leaseid-mismatch",
    propertyName: "dispatches-get-moderator-sees-record",
    timeoutMs: DEFAULT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerDispatchesGetNonModeratorRejected fails when non-moderator dispatches/get returns the wrong error code",
    register: registerDispatchesGetNonModeratorRejected,
    behavior: "getlease-allow-non-moderator",
    propertyName: "dispatches-get-non-moderator-rejected",
    timeoutMs: DEFAULT_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerSameConversationDispatchesConcurrent fails when concurrent leases collide on leaseId",
    register: registerSameConversationDispatchesConcurrent,
    behavior: "lease-id-collision",
    propertyName: "same-conversation-dispatches-reach-moderator-concurrently",
    timeoutMs: SLOW_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerSlowFirstDoesNotDelaySecondAck fails when server serializes acks behind the first moderator reply",
    register: registerSlowFirstDoesNotDelaySecondAck,
    behavior: "serialize-second-ack",
    propertyName: "slow-first-moderator-call-does-not-delay-second-ack",
    timeoutMs: SLOW_PROOF_TIMEOUT_MS,
  },
  {
    title:
      "registerReleaseForOneLeaseDoesNotWaitOnAnother fails when server emits releases in mint-order",
    register: registerReleaseForOneLeaseDoesNotWaitOnAnother,
    behavior: "release-out-of-order",
    propertyName: "recipient.waitForRelease",
    timeoutMs: SLOW_PROOF_TIMEOUT_MS,
  },
];

describe("dispatch-admission known-bad-server divergence proofs", () => {
  it("proof matrix maps every case to a named behavior", () => {
    fc.assert(fc.property(fc.constantFrom(...DISPATCH_PROOF_CASES), hasCase));
    expect(DISPATCH_PROOF_CASES).toHaveLength(15);
  });

  for (const proof of DISPATCH_PROOF_CASES) {
    it(
      proof.title,
      () => {
        expect.hasAssertions();
        return Effect.runPromise(runDispatchProofCase(proof));
      },
      proof.timeoutMs,
    );
  }
});

const hasCase = (proof: DispatchProofCase): boolean =>
  proof.title.length > 0 &&
  proof.propertyName.length > 0 &&
  proof.behavior.length > 0;

const runDispatchProofCase = (proof: DispatchProofCase): Effect.Effect<void> =>
  Effect.gen(function* () {
    const failure = yield* runSingleDispatchProof(proof.register, {
      behavior: proof.behavior,
    });
    expectInvariant(failure, proof.propertyName);
  });
