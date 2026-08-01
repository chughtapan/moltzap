/**
 * `agent/dispatch/request`, `app/dispatch/authorize`,
 * `agent/dispatch/released`, and `app/dispatch/lease-*` admission surface.
 *
 * Bucket file: `concurrency` group. Each bucket owns its own server fixture so
 * vitest can execute buckets concurrently without sharing state.
 *
 * The recipient calls `agent/dispatch/request` over WS. An available
 * conversation returns a lease synchronously and forks the moderator
 * round-trip; a reserved conversation returns `conversation_busy` without a
 * lease. The recipient observes minted-lease verdicts via
 * `agent/dispatch/released`. `agent/message/send(dispatchLeaseId=X)` consumes a
 * lease via `Effect.acquireUseRelease(claim, sendInsert+commit,
 * finalize|rollback)`.
 */
import { it as effectIt } from "@effect/vitest";
import { dispatchRelease } from "@moltzap/protocol/message/dispatch";
import type { AppManifest } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import { Chunk, Duration, Effect, Either, Fiber, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  DISPATCH_RELEASE_TIMEOUT_MS,
  DISPATCH_REQUEST_CONCURRENCY,
  DISPATCH_STATE_CONSUMED,
  attachDispatchAuthorizeHook,
  createConversationOnApp,
  createDispatchFlowFixture,
  MODERATED_HOOKS,
  readLeaseByLeaseId,
  requestDispatch,
  requestDispatchOutcome,
  sendMessageWithLease,
  startDispatchFlowServer,
  stopDispatchFlowServer,
  waitForDispatchRelease,
} from "./fixture.js";
import {
  getKyselyDb,
  setupAgentPair,
  type ConnectedAgent,
} from "../../helpers.js";

const it = effectIt.live;

const TEST_APP_ID = "00000000-0000-4000-8000-000000010001";
const EXPECTED_HOOK_CALLS = 2;
const LEASE_TTL_MS = 60_000;

const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Moderator Dispatch Test App",
  hooks: MODERATED_HOOKS,
};

const fixture = createDispatchFlowFixture();

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
      requestDispatchOutcome(bob, conversationIds[0], alice, "first"),
      requestDispatchOutcome(bob, conversationIds[1], alice, "second"),
    ],
    { concurrency: DISPATCH_REQUEST_CONCURRENCY },
  );
}

function forkReleaseCollector(recipient: ConnectedAgent, count: number) {
  return recipient.client.subscribe(dispatchRelease).pipe(
    Stream.take(count),
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
    yield* attachDispatchAuthorizeHook(fixture);
    const conv1 = yield* createConversationOnApp(alice, bob, TEST_APP_MANIFEST);
    const conv2 = yield* createConversationOnApp(alice, bob, TEST_APP_MANIFEST);
    const releasesFiber = yield* forkReleaseCollector(bob, 2);
    const [outcome1, outcome2] = yield* requestDispatchesInParallel(
      alice,
      bob,
      [conv1.conversationId, conv2.conversationId],
    );
    if ("outcome" in outcome1 || "outcome" in outcome2) {
      return yield* Effect.dieMessage(
        "distinct conversations must both mint dispatch leases",
      );
    }

    expect(outcome1.leaseId).not.toBe(outcome2.leaseId);
    const releases = yield* Fiber.join(releasesFiber);
    expect(releases).toHaveLength(EXPECTED_HOOK_CALLS);
    const seen = new Set(releases.map((release) => release.leaseId));
    expect(seen.has(outcome1.leaseId)).toBe(true);
    expect(seen.has(outcome2.leaseId)).toBe(true);
    expect(fixture.hookCalls()).toBe(EXPECTED_HOOK_CALLS);
  });
}

function sameConversationRequestsReturnBusy() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    yield* attachDispatchAuthorizeHook(fixture);
    const conv = yield* createConversationOnApp(alice, bob, TEST_APP_MANIFEST);
    const releasesFiber = yield* forkReleaseCollector(bob, 1);
    const [outcome1, outcome2] = yield* requestDispatchesInParallel(
      alice,
      bob,
      [conv.conversationId, conv.conversationId],
    );
    const leaseOutcome = "outcome" in outcome1 ? outcome2 : outcome1;
    const busyOutcome = "outcome" in outcome1 ? outcome1 : outcome2;
    if ("outcome" in leaseOutcome || !("outcome" in busyOutcome)) {
      return yield* Effect.dieMessage(
        "same-conversation requests must return one lease and one busy outcome",
      );
    }

    expect(busyOutcome).toEqual({ outcome: "conversation_busy" });
    const releases = yield* Fiber.join(releasesFiber);
    expect(releases).toHaveLength(1);
    expect(releases[0]?.leaseId).toBe(leaseOutcome.leaseId);
    expect(fixture.hookCalls()).toBe(1);

    yield* sendMessageWithLease(bob, conv, leaseOutcome.leaseId, "consume");
    const nextReleaseFiber = yield* waitForDispatchRelease(bob);
    const next = yield* requestDispatch(bob, conv.conversationId, alice);
    yield* Fiber.join(nextReleaseFiber);
    expect(next.leaseId).not.toBe(leaseOutcome.leaseId);
    expect(fixture.hookCalls()).toBe(2);
  });
}

function requestGrantedDispatchLease(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
) {
  return Effect.gen(function* () {
    fixture.setNextHookVerdict({
      decision: "grant",
      leaseTimeoutMs: LEASE_TTL_MS,
    });
    yield* attachDispatchAuthorizeHook(fixture);
    const binding = yield* createConversationOnApp(
      alice,
      bob,
      TEST_APP_MANIFEST,
    );
    const releaseFiber = yield* waitForDispatchRelease(bob);
    const ack = yield* requestDispatch(
      bob,
      binding.conversationId,
      alice,
      "same lease",
    );
    yield* Fiber.join(releaseFiber);
    return { binding, leaseId: ack.leaseId };
  });
}

function readMessageIds(conversationId: ConversationId) {
  return Effect.tryPromise(() =>
    getKyselyDb()
      .selectFrom("messages")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .execute(),
  );
}

function sameLeaseSendsCommitExactlyOnce() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const { binding, leaseId } = yield* requestGrantedDispatchLease(alice, bob);
    const outcomes = yield* Effect.all(
      [
        sendMessageWithLease(bob, binding, leaseId, "first").pipe(
          Effect.either,
        ),
        sendMessageWithLease(bob, binding, leaseId, "second").pipe(
          Effect.either,
        ),
      ],
      { concurrency: 2 },
    );
    const successes = outcomes.filter(Either.isRight);

    expect(successes).toHaveLength(1);
    expect(outcomes.filter(Either.isLeft)).toHaveLength(1);
    const success = successes[0];
    if (success === undefined) {
      return yield* Effect.dieMessage("expected one successful lease send");
    }

    const rows = yield* readMessageIds(binding.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(success.right.message.id);

    const record = yield* readLeaseByLeaseId(leaseId);
    expect(record.state).toBe(DISPATCH_STATE_CONSUMED);
    expect(record.consumedMessageId).toBe(success.right.message.id);
  });
}

describe("dispatch/* — concurrency", () => {
  it(
    "cross-conversation concurrency: two agent/dispatch/request in different conversations run concurrently",
    crossConversationRequestsRunConcurrently,
    25_000,
  );

  it(
    "same-conversation concurrency: one request mints a lease and one returns conversation_busy",
    sameConversationRequestsReturnBusy,
    25_000,
  );

  it(
    "same-lease concurrency: exactly one message send commits",
    sameLeaseSendsCommitExactlyOnce,
    25_000,
  );
});
