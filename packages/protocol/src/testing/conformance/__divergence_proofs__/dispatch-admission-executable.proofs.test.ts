/**
 * #529 reshape additive — divergence proofs for the 15
 * `dispatch-admission` registrars (12 new + 3 rewritten dispatcher-
 * concurrency P1-P3 closing #358).
 *
 * Each registrar's body in `dispatch-admission.ts` currently emits a
 * typed `PropertyDeferred` because cross-impl execution requires the
 * conformance `TestServer` to drive both ends of the dispatch round-
 * trip (recipient calls `dispatch/request`; moderator (a separate test
 * client) replies via `dispatch/authorize`). That driver is the row 13
 * cutover follow-up — see `suite.ts:336-361` allowed-coverage-gaps
 * table where every property below is registered as a deferred gap
 * with the follow-up reason "cross-impl `dispatch/request` driver in
 * TestServer".
 *
 * Server-side (in-process) coverage of the same 17 architect-§8
 * scenarios lives in
 * `packages/server/src/__tests__/integration/dispatch-flow.integration.test.ts`
 * — the 15 conformance properties here are the cross-impl gate.
 *
 * The proofs below confirm three load-bearing properties of every
 * registrar:
 *
 *   1. The registrar is wired into the suite (gate's grep dependency).
 *   2. Running it emits a typed `PropertyDeferred` failure — NOT a
 *      silent pass (which would let a regressing impl through), NOT
 *      an untyped defect (which would crash the runner).
 *   3. The `followUp` reason cites the row 13 cross-impl driver, so
 *      the deferral is auditable and the cutover knows where to look.
 *
 * When the row 13 cross-impl driver lands, every registrar body
 * becomes a real assertion against a TestServer-driven dispatch
 * round-trip; each proof here flips to `expectInvariant` /
 * `expectAssertionFailure` against a misbehaving server (the same
 * pattern as `server-executable.proofs.test.ts:registerAuthorityNegative`
 * etc.). Removing this file is part of that PR.
 */
import { describe, it } from "vitest";
import { Effect, Ref } from "effect";
import {
  registerDispatchAuthorizeTimeoutSynthesizesDeny,
  registerDispatchAuthorizeVerdictResolves,
  registerDispatchReleaseFiresAfterResolve,
  registerDispatchReleaseSkippedOnAbandoned,
  registerDispatchRequestAckMintsLease,
  registerDispatchRequestRecipientDisconnectAbandons,
  registerDispatchesConsumedFiresOnFirstSend,
  registerDispatchesConsumedSuppressedOnSecondSend,
  registerDispatchesExpiredFiresOnTtl,
  registerDispatchesExpiredSuppressedOnConsumeBeforeTtl,
  registerDispatchesGetModeratorSeesRecord,
  registerDispatchesGetNonModeratorRejected,
  registerReleaseForOneLeaseDoesNotWaitOnAnother,
  registerSameConversationDispatchesConcurrent,
  registerSlowFirstDoesNotDelaySecondAck,
} from "../dispatch-admission.js";
import { collectProperties, type PropertyFailure } from "../registry.js";
import type {
  ConformanceArtifact,
  ConformanceRunContext,
  RealServerHandle,
} from "../runner.js";
import {
  expectDeferred,
  runExpectingFailure,
} from "./executable-proof-helpers.js";

const CROSS_IMPL_DRIVER_REASON = "cross-impl `dispatch/request` driver";

type Registrar = (ctx: ConformanceRunContext) => void;

/**
 * Build a minimal `ConformanceRunContext` for proof-time use. The
 * dispatch-admission registrars are tombstones — they immediately
 * `Effect.fail(PropertyDeferred)` without touching the real server
 * handle — so a stub server URL is sufficient. When the row 13
 * cutover lands and properties acquire bodies, this stub is
 * replaced by the same bad-server harness `server-executable.proofs`
 * uses today.
 */
function makeStubContext(): Effect.Effect<ConformanceRunContext> {
  return Effect.gen(function* () {
    const artifacts = yield* Ref.make<ReadonlyArray<ConformanceArtifact>>([]);
    const realServer: RealServerHandle = {
      baseUrl: "http://127.0.0.1:0",
      wsUrl: "ws://127.0.0.1:0",
      close: Effect.void,
    };
    return {
      realServer,
      toxiproxy: null,
      opts: {
        tiers: ["A", "B", "C", "E"],
        realServer: Effect.succeed(realServer),
        numRuns: 1,
      },
      seed: 42,
      artifacts,
    } satisfies ConformanceRunContext;
  });
}

async function runDispatchProof(register: Registrar): Promise<PropertyFailure> {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const ctx = yield* makeStubContext();
      register(ctx);
      const properties = collectProperties(ctx);
      if (properties.length !== 1) {
        return yield* Effect.die(
          new Error(`expected one property, got ${properties.length}`),
        );
      }
      return yield* runExpectingFailure(properties[0]!);
    }),
  );
  if (exit._tag === "Failure") {
    throw new Error(`proof harness defect: ${exit.cause.toString()}`);
  }
  return exit.value;
}

describe("dispatch-admission divergence proofs (#529)", () => {
  it("registerDispatchRequestAckMintsLease emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerDispatchRequestAckMintsLease,
    );
    expectDeferred(
      failure,
      "dispatch-request-ack-mints-lease",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerDispatchRequestRecipientDisconnectAbandons emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerDispatchRequestRecipientDisconnectAbandons,
    );
    expectDeferred(
      failure,
      "dispatch-request-recipient-disconnect-abandons-lease",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerDispatchAuthorizeVerdictResolves emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerDispatchAuthorizeVerdictResolves,
    );
    expectDeferred(
      failure,
      "dispatch-authorize-verdict-resolves-lease",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerDispatchAuthorizeTimeoutSynthesizesDeny emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerDispatchAuthorizeTimeoutSynthesizesDeny,
    );
    expectDeferred(
      failure,
      "dispatch-authorize-timeout-synthesizes-deny",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerDispatchReleaseFiresAfterResolve emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerDispatchReleaseFiresAfterResolve,
    );
    expectDeferred(
      failure,
      "dispatch-release-fires-after-resolve",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerDispatchReleaseSkippedOnAbandoned emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerDispatchReleaseSkippedOnAbandoned,
    );
    expectDeferred(
      failure,
      "dispatch-release-skipped-on-abandoned",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerDispatchesConsumedFiresOnFirstSend emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerDispatchesConsumedFiresOnFirstSend,
    );
    expectDeferred(
      failure,
      "dispatches-consumed-fires-on-first-send",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerDispatchesConsumedSuppressedOnSecondSend emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerDispatchesConsumedSuppressedOnSecondSend,
    );
    expectDeferred(
      failure,
      "dispatches-consumed-suppressed-on-second-send",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerDispatchesExpiredFiresOnTtl emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(registerDispatchesExpiredFiresOnTtl);
    expectDeferred(
      failure,
      "dispatches-expired-fires-on-ttl",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerDispatchesExpiredSuppressedOnConsumeBeforeTtl emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerDispatchesExpiredSuppressedOnConsumeBeforeTtl,
    );
    expectDeferred(
      failure,
      "dispatches-expired-suppressed-on-consume-before-ttl",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerDispatchesGetModeratorSeesRecord emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerDispatchesGetModeratorSeesRecord,
    );
    expectDeferred(
      failure,
      "dispatches-get-moderator-sees-record",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerDispatchesGetNonModeratorRejected emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerDispatchesGetNonModeratorRejected,
    );
    expectDeferred(
      failure,
      "dispatches-get-non-moderator-rejected",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerSameConversationDispatchesConcurrent emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerSameConversationDispatchesConcurrent,
    );
    expectDeferred(
      failure,
      "same-conversation-dispatches-reach-moderator-concurrently",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerSlowFirstDoesNotDelaySecondAck emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerSlowFirstDoesNotDelaySecondAck,
    );
    expectDeferred(
      failure,
      "slow-first-moderator-call-does-not-delay-second-ack",
      CROSS_IMPL_DRIVER_REASON,
    );
  });

  it("registerReleaseForOneLeaseDoesNotWaitOnAnother emits typed PropertyDeferred citing row-13 cross-impl driver", async () => {
    const failure = await runDispatchProof(
      registerReleaseForOneLeaseDoesNotWaitOnAnother,
    );
    expectDeferred(
      failure,
      "release-for-one-lease-does-not-wait-on-another",
      CROSS_IMPL_DRIVER_REASON,
    );
  });
});
