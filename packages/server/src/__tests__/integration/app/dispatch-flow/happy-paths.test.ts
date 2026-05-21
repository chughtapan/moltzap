/**
 * #529 reshape additive — `dispatch/{request, authorize, release}` +
 * `dispatches/{consumed, expired, get}` admission surface.
 *
 * Bucket file: `happy-paths` group. Split from `dispatch-flow.integration.test.ts`
 * (Phase 2B reorg, #543). Each split file owns its own server-fixture
 * `beforeAll`/`afterAll`/`beforeEach` so vitest's `fileParallelism: true`
 * runner can execute buckets concurrently without sharing state.
 *
 * See parent dispatch-flow architecture comment in the original file
 * (now replaced by these 6 bucket files): the recipient calls
 * `dispatch/request` over WS; server mints a lease, returns ack
 * synchronously, forks the moderator round-trip; recipient observes
 * the verdict via `dispatch/release` notification. `messages/send(
 * dispatchLeaseId=X)` consumes the lease via `Effect.acquireUseRelease(
 * claim, sendInsert+commit, finalize|rollback)`.
 */
import { it as effectIt } from "@effect/vitest";
import type { AppManifest } from "@moltzap/protocol";
import { Effect, Fiber } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  DISPATCH_RELEASE_TIMEOUT_MS,
  DISPATCH_VERDICT_GRANT,
  EXPECTED_TYPE_STRING,
  createModeratedDm,
  createUnmoderatedDm,
  createDispatchFlowFixture,
  requestDispatch,
  startDispatchFlowServer,
  stopDispatchFlowServer,
  waitForDispatchRelease,
} from "./fixture.js";
import { setupAgentPair } from "../../helpers.js";

const it = effectIt.live;

const TEST_APP_ID = "moderator-dispatch-test-app";
const EXPECTED_MODERATED_HOOK_CALLS = 1;
const EXPECTED_UNMODERATED_HOOK_CALLS = 0;

const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Moderator Dispatch Test App",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

const fixture = createDispatchFlowFixture(TEST_APP_MANIFEST);

beforeAll(startDispatchFlowServer, 60_000);

afterAll(stopDispatchFlowServer);

beforeEach(() => Effect.runPromise(fixture.reset));

function expectAckShape(ack: { leaseId: string; dispatchId: string }) {
  expect(typeof ack.leaseId).toBe(EXPECTED_TYPE_STRING);
  expect(typeof ack.dispatchId).toBe(EXPECTED_TYPE_STRING);
  expect(ack.leaseId).not.toBe(ack.dispatchId);
}

function expectGrantRelease(
  release: { leaseId: string; verdict: { decision: string } },
  leaseId: string,
) {
  expect(release.leaseId).toBe(leaseId);
  expect(release.verdict.decision).toBe(DISPATCH_VERDICT_GRANT);
}

function moderatedDispatchReleasesGrant() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    fixture.setNextHookVerdict({ decision: "grant" });
    const { conversationId } = yield* createModeratedDm(
      alice,
      bob,
      TEST_APP_ID,
    );
    // Fork-before-trigger (Spec B #596 r2 fix).
    const releaseFiber = yield* waitForDispatchRelease(
      bob,
      DISPATCH_RELEASE_TIMEOUT_MS,
    );
    const ack = yield* requestDispatch(bob, conversationId, alice);
    const release = yield* Fiber.join(releaseFiber);

    expectAckShape(ack);
    expectGrantRelease(release, ack.leaseId);
    expect(fixture.hookCalls()).toBe(EXPECTED_MODERATED_HOOK_CALLS);
  });
}

function unmoderatedDispatchDefaultGrants() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const { conversationId } = yield* createUnmoderatedDm(alice, bob);
    const releaseFiber = yield* waitForDispatchRelease(
      bob,
      DISPATCH_RELEASE_TIMEOUT_MS,
    );
    const ack = yield* requestDispatch(bob, conversationId, alice);
    const release = yield* Fiber.join(releaseFiber);

    expectGrantRelease(release, ack.leaseId);
    expect(fixture.hookCalls()).toBe(EXPECTED_UNMODERATED_HOOK_CALLS);
  });
}

function dispatchRequestDescriptorIsRegistered() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const { conversationId } = yield* createUnmoderatedDm(alice, bob);
    const ack = yield* requestDispatch(bob, conversationId, alice, "canary");

    expectAckShape(ack);
  });
}

describe("dispatch/* — happy paths (#529 reshape additive)", () => {
  it(
    "happy path moderated: dispatch/request then moderator grant releases grant",
    moderatedDispatchReleasesGrant,
    20_000,
  );

  it(
    "happy path default-grant: unmoderated task releases grant immediately",
    unmoderatedDispatchDefaultGrants,
    20_000,
  );

  it(
    "wire surface canary: dispatch/request descriptor is registered",
    dispatchRequestDescriptorIsRegistered,
    20_000,
  );
});
