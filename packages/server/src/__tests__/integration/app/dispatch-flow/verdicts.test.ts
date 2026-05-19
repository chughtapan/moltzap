/**
 * #529 reshape additive — `dispatch/{request, authorize, release}` +
 * `dispatches/{consumed, expired, get}` admission surface.
 *
 * Bucket file: `verdicts` group. Split from `dispatch-flow.integration.test.ts`
 * (Phase 2B reorg, #543). Each split file owns its own server-fixture
 * `beforeAll`/`afterAll`/`beforeEach` so vitest's `fileParallelism: true`
 * runner can execute buckets concurrently without sharing state.
 */
import { it as effectIt } from "@effect/vitest";
import type { AppManifest } from "@moltzap/protocol";
import { Effect, Fiber } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  DISPATCH_RELEASE_TIMEOUT_MS,
  DISPATCH_VERDICT_DENY,
  DISPATCH_VERDICT_HOLD,
  MODERATOR_TIMEOUT_REASON,
  createDispatchFlowFixture,
  createModeratedDm,
  requestDispatch,
  startDispatchFlowServer,
  stopDispatchFlowServer,
  waitForDispatchRelease,
  waitForParticipantsRemoved,
} from "./fixture.js";
import { setupAgentPair, type ConnectedAgent } from "../../helpers.js";

const it = effectIt.live;

const TEST_APP_ID = "moderator-dispatch-test-app";
const DENIAL_REASON = "phase closed";
const HOLD_REASON = "waiting for turn";
const MODERATOR_TIMEOUT_MS = 10_000;

const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Moderator Dispatch Test App",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

const fixture = createDispatchFlowFixture(TEST_APP_MANIFEST);

beforeAll(startDispatchFlowServer, 60_000);

afterAll(stopDispatchFlowServer);

beforeEach(() => Effect.runPromise(fixture.reset));

function requestModeratedDispatch(alice: ConnectedAgent, bob: ConnectedAgent) {
  return Effect.gen(function* () {
    const conversationId = yield* createModeratedDm(alice, bob, TEST_APP_ID);
    const ack = yield* requestDispatch(bob, conversationId, alice);
    return { ack, conversationId };
  });
}

function expectReleaseVerdict(
  release: { leaseId: string; verdict: { decision: string; reason?: string } },
  expected: {
    readonly leaseId: string;
    readonly decision: string;
    readonly reason?: string;
  },
) {
  expect(release.leaseId).toBe(expected.leaseId);
  expect(release.verdict.decision).toBe(expected.decision);
  if (expected.reason !== undefined) {
    expect(release.verdict.reason).toBe(expected.reason);
  }
}

function expectParticipantRemoved(
  removed: { conversationId: string; agentId: string },
  expected: { readonly conversationId: string; readonly agentId: string },
) {
  expect(removed.conversationId).toBe(expected.conversationId);
  expect(removed.agentId).toBe(expected.agentId);
}

function moderatorDenyReleasesDeny() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    fixture.setNextHookVerdict({
      decision: "deny",
      reason: DENIAL_REASON,
    });
    // Fork-before-trigger (Spec B #596 r2 fix): subscribe BEFORE the
    // requestDispatch RPC fires so the release notification can't arrive
    // in the gap before subscription.
    const releaseFiber = yield* waitForDispatchRelease(bob);
    const { ack } = yield* requestModeratedDispatch(alice, bob);
    const release = yield* Fiber.join(releaseFiber);

    expectReleaseVerdict(release, {
      leaseId: ack.leaseId,
      decision: DISPATCH_VERDICT_DENY,
      reason: DENIAL_REASON,
    });
  });
}

function moderatorHoldReleasesHold() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    fixture.setNextHookVerdict({
      decision: "hold",
      reason: HOLD_REASON,
    });
    const releaseFiber = yield* waitForDispatchRelease(bob);
    const { ack } = yield* requestModeratedDispatch(alice, bob);
    const release = yield* Fiber.join(releaseFiber);

    expectReleaseVerdict(release, {
      leaseId: ack.leaseId,
      decision: DISPATCH_VERDICT_HOLD,
    });
  });
}

function moderatorTimeoutRemovesRecipient() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    fixture.setNextHookVerdict({ kind: "never-reply" });
    // Fork BOTH subscribers before trigger (Spec B #596 r2 fix). With
    // fork-before-trigger, the participants/removed timer starts at fork
    // time, NOT after release — so it must cover the full
    // moderator-timeout (release fires at +10s) + the release→removed gap
    // (the server emits removed only after the timeout-induced deny).
    const releaseFiber = yield* waitForDispatchRelease(
      bob,
      MODERATOR_TIMEOUT_MS,
    );
    const removedFiber = yield* waitForParticipantsRemoved(
      bob,
      MODERATOR_TIMEOUT_MS + DISPATCH_RELEASE_TIMEOUT_MS,
    );
    const { ack, conversationId } = yield* requestModeratedDispatch(alice, bob);
    const release = yield* Fiber.join(releaseFiber);

    expectReleaseVerdict(release, {
      leaseId: ack.leaseId,
      decision: DISPATCH_VERDICT_DENY,
      reason: MODERATOR_TIMEOUT_REASON,
    });
    const removed = yield* Fiber.join(removedFiber);
    expectParticipantRemoved(removed, { conversationId, agentId: bob.agentId });
  });
}

function explicitDenyRemovesRecipient() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    fixture.setNextHookVerdict({
      decision: "deny",
      reason: DENIAL_REASON,
    });
    const releaseFiber = yield* waitForDispatchRelease(bob);
    const removedFiber = yield* waitForParticipantsRemoved(bob);
    const { ack, conversationId } = yield* requestModeratedDispatch(alice, bob);
    const release = yield* Fiber.join(releaseFiber);

    expectReleaseVerdict(release, {
      leaseId: ack.leaseId,
      decision: DISPATCH_VERDICT_DENY,
    });
    const removed = yield* Fiber.join(removedFiber);
    expectParticipantRemoved(removed, { conversationId, agentId: bob.agentId });
  });
}

describe("dispatch/* — release verdicts (#529 reshape additive)", () => {
  it("moderator deny releases deny", moderatorDenyReleasesDeny, 20_000);
  it("moderator hold releases hold", moderatorHoldReleasesHold, 20_000);
});

describe("dispatch/* — deny removes recipient (#529 reshape additive)", () => {
  it(
    "moderator timeout releases deny and removes the recipient",
    moderatorTimeoutRemovesRecipient,
    25_000,
  );

  it(
    "explicit moderator deny releases deny and removes the recipient",
    explicitDenyRemovesRecipient,
    20_000,
  );
});
