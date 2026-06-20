/**
 * `agent/dispatch/request`, `app/dispatch/authorize`,
 * `agent/dispatch/released`, and `app/dispatch/lease-*` admission surface.
 *
 * Bucket file: `verdicts` group. Each bucket owns its own server fixture so
 * vitest can execute buckets concurrently without sharing state.
 */
import { it as effectIt } from "@effect/vitest";
import type { AppManifest } from "@moltzap/protocol/identity";
import { Effect, Fiber } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  DISPATCH_RELEASE_TIMEOUT_MS,
  DISPATCH_VERDICT_DENY,
  DISPATCH_VERDICT_HOLD,
  MODERATOR_TIMEOUT_REASON,
  createDispatchFlowFixture,
  MODERATED_HOOKS,
  attachDispatchAuthorizeHook,
  createConversationOnApp,
  requestDispatch,
  startDispatchFlowServer,
  stopDispatchFlowServer,
  waitForDispatchRelease,
  waitForParticipantsRemoved,
} from "./fixture.js";
import { setupAgentPair, type ConnectedAgent } from "../../helpers.js";

const it = effectIt.live;

const TEST_APP_ID = "00000000-0000-4000-8000-000000010001";
const DENIAL_REASON = "phase closed";
const HOLD_REASON = "waiting for turn";
const MODERATOR_TIMEOUT_MS = 10_000;

const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Moderator Dispatch Test App",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
  hooks: MODERATED_HOOKS,
};

const fixture = createDispatchFlowFixture(TEST_APP_MANIFEST);

beforeAll(startDispatchFlowServer, 60_000);

afterAll(stopDispatchFlowServer);

beforeEach(() => Effect.runPromise(fixture.reset));

function requestModeratedDispatch(alice: ConnectedAgent, bob: ConnectedAgent) {
  return Effect.gen(function* () {
    yield* attachDispatchAuthorizeHook(alice, fixture);
    const { conversationId } = yield* createConversationOnApp(
      alice,
      bob,
      TEST_APP_MANIFEST,
    );
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
  removed: { conversationId: string; removedAgentId: string },
  expected: { readonly conversationId: string; readonly agentId: string },
) {
  expect(removed.conversationId).toBe(expected.conversationId);
  expect(removed.removedAgentId).toBe(expected.agentId);
}

function moderatorDenyReleasesDeny() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    fixture.setNextHookVerdict({
      decision: "deny",
      reason: DENIAL_REASON,
    });
    // Subscribe before requestDispatch so the release notification can't arrive
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
    // Subscribe to both notifications before triggering the RPC. The
    // participants/removed timeout starts at fork time, so it must cover the
    // moderator timeout plus the release-to-removed gap.
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

describe("dispatch/* — release verdicts", () => {
  it("moderator deny releases deny", moderatorDenyReleasesDeny, 20_000);
  it("moderator hold releases hold", moderatorHoldReleasesHold, 20_000);
});

describe("dispatch/* — deny removes recipient", () => {
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
