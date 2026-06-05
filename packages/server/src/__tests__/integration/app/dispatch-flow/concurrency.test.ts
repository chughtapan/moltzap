/**
 * #529 reshape additive — `dispatch/{request, authorize, release}` +
 * `dispatches/{consumed, expired, get}` admission surface.
 *
 * Bucket file: `concurrency` group. Split from `dispatch-flow.integration.test.ts`
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
import { DispatchRelease } from "@moltzap/protocol/dispatch";
import type { AppManifest } from "@moltzap/protocol/app";
import type { ConversationId } from "@moltzap/protocol/conversation";
import { Chunk, Duration, Effect, Fiber, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  DISPATCH_RELEASE_TIMEOUT_MS,
  DISPATCH_REQUEST_CONCURRENCY,
  attachDispatchAuthorizeHook,
  createTaskConversationOnApp,
  createDispatchFlowFixture,
  MODERATED_HOOKS,
  requestDispatch,
  startDispatchFlowServer,
  stopDispatchFlowServer,
} from "./fixture.js";
import { setupAgentPair, type ConnectedAgent } from "../../helpers.js";

const it = effectIt.live;

const TEST_APP_ID = "00000000-0000-4000-8000-000000010001";
const EXPECTED_HOOK_CALLS = 2;

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

function requestDispatchesInParallel(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
  conversationIds: readonly [ConversationId, ConversationId],
) {
  return Effect.all(
    [
      requestDispatch(bob, conversationIds[0], alice, "first"),
      requestDispatch(bob, conversationIds[1], alice, "second"),
    ],
    { concurrency: DISPATCH_REQUEST_CONCURRENCY },
  );
}

function forkTwoReleaseCollector(recipient: ConnectedAgent) {
  return recipient.client.subscribe(DispatchRelease).pipe(
    Stream.take(2),
    Stream.runCollect,
    Effect.map(Chunk.toReadonlyArray),
    Effect.timeoutFail({
      duration: Duration.millis(DISPATCH_RELEASE_TIMEOUT_MS),
      onTimeout: () => new Error("timed out waiting for dispatch releases"),
    }),
    Effect.fork,
  );
}

function crossConversationRequestsRunConcurrently() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    yield* attachDispatchAuthorizeHook(alice, fixture);
    const conv1 = yield* createTaskConversationOnApp(
      alice,
      bob,
      TEST_APP_MANIFEST,
    );
    const conv2 = yield* createTaskConversationOnApp(
      alice,
      bob,
      TEST_APP_MANIFEST,
    );
    const releasesFiber = yield* forkTwoReleaseCollector(bob);
    const [ack1, ack2] = yield* requestDispatchesInParallel(alice, bob, [
      conv1.conversationId,
      conv2.conversationId,
    ]);

    expect(ack1.leaseId).not.toBe(ack2.leaseId);
    const releases = yield* Fiber.join(releasesFiber);
    expect(releases).toHaveLength(EXPECTED_HOOK_CALLS);
    const seen = new Set(releases.map((release) => release.leaseId));
    expect(seen.has(ack1.leaseId)).toBe(true);
    expect(seen.has(ack2.leaseId)).toBe(true);
    expect(fixture.hookCalls()).toBe(EXPECTED_HOOK_CALLS);
  });
}

function sameConversationRequestsRunConcurrently() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    yield* attachDispatchAuthorizeHook(alice, fixture);
    const conv = yield* createTaskConversationOnApp(
      alice,
      bob,
      TEST_APP_MANIFEST,
    );
    const releasesFiber = yield* forkTwoReleaseCollector(bob);
    const [ack1, ack2] = yield* requestDispatchesInParallel(alice, bob, [
      conv.conversationId,
      conv.conversationId,
    ]);

    expect(ack1.leaseId).not.toBe(ack2.leaseId);
    expect(ack1.dispatchId).not.toBe(ack2.dispatchId);
    expect(yield* Fiber.join(releasesFiber)).toHaveLength(EXPECTED_HOOK_CALLS);
    expect(fixture.hookCalls()).toBe(EXPECTED_HOOK_CALLS);
  });
}

describe("dispatch/* — concurrency (#529 reshape additive)", () => {
  it(
    "cross-conversation concurrency: two dispatch/request in different (taskId, conversationId) run concurrently",
    crossConversationRequestsRunConcurrently,
    25_000,
  );

  it(
    "same-conversation concurrency: two dispatch/request in same (taskId, conversationId) run concurrently",
    sameConversationRequestsRunConcurrently,
    25_000,
  );
});
