/**
 * `dispatch/{request, authorize, release}` + `dispatches/{consumed, expired,
 * get}` admission surface.
 *
 * Bucket file: `happy-paths` group. Each bucket owns its own server fixture so
 * vitest can execute buckets concurrently without sharing state.
 *
 * The recipient calls `dispatch/request` over WS; server mints a lease, returns ack
 * synchronously, forks the moderator round-trip; recipient observes
 * the verdict via `dispatch/release` notification. `messages/send(
 * dispatchLeaseId=X)` consumes the lease via `Effect.acquireUseRelease(
 * claim, sendInsert+commit, finalize|rollback)`.
 */
import { it as effectIt } from "@effect/vitest";
import type { AppManifest } from "@moltzap/protocol/app";
import { Effect, Fiber } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  DISPATCH_RELEASE_TIMEOUT_MS,
  DISPATCH_VERDICT_GRANT,
  EXPECTED_TYPE_STRING,
  attachDispatchAuthorizeHook,
  createTaskConversationOnApp,
  createDispatchFlowFixture,
  MODERATED_HOOKS,
  requestDispatch,
  startDispatchFlowServer,
  stopDispatchFlowServer,
  waitForDispatchRelease,
} from "./fixture.js";
import { setupAgentPair } from "../../helpers.js";

const it = effectIt.live;

const TEST_APP_ID = "00000000-0000-4000-8000-000000010001";
const EXPECTED_MODERATED_HOOK_CALLS = 1;

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
    yield* attachDispatchAuthorizeHook(alice, fixture);
    const { conversationId } = yield* createTaskConversationOnApp(
      alice,
      bob,
      TEST_APP_MANIFEST,
    );
    // Subscribe before the trigger RPC so the release notification is observed.
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

describe("dispatch/* — happy paths", () => {
  it(
    "happy path moderated: dispatch/request then moderator grant releases grant",
    moderatedDispatchReleasesGrant,
    20_000,
  );
});
