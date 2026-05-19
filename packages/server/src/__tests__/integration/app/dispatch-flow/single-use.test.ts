/**
 * #529 reshape additive: dispatch admission single-use lease behavior.
 */
import { it as effectIt } from "@effect/vitest";
import {
  ConversationsArchive,
  type AppManifest,
  type ConversationId,
} from "@moltzap/protocol";
import { Effect, Fiber } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  DISPATCH_STATE_CONSUMED,
  DISPATCH_STATE_GRANTED,
  EXPECTED_TYPE_STRING,
  createDispatchFlowFixture,
  createModeratedDm,
  createUnmoderatedDm,
  readLeaseByLeaseId,
  requestDispatch,
  sendMessageWithLease,
  startDispatchFlowServer,
  stopDispatchFlowServer,
  waitForDispatchRelease,
} from "./fixture.js";
import {
  expectEitherLeft,
  setupAgentPair,
  type ConnectedAgent,
} from "../../helpers.js";

const it = effectIt.live;

const TEST_APP_ID = "moderator-dispatch-test-app";

const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Moderator Dispatch Test App",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

const fixture = createDispatchFlowFixture(TEST_APP_MANIFEST);

beforeAll(startDispatchFlowServer, 60_000);

afterAll(stopDispatchFlowServer);

beforeEach(() => Effect.runPromise(fixture.reset));

function requestPendingModeratedDispatch(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
) {
  return Effect.gen(function* () {
    fixture.setNextHookVerdict({ kind: "never-reply" });
    const conversationId = yield* createModeratedDm(alice, bob, TEST_APP_ID);
    const ack = yield* requestDispatch(bob, conversationId, alice, "race");
    return { ack, conversationId };
  }).pipe(Effect.withSpan("requestPendingModeratedDispatch"));
}

function requestGrantedModeratedDispatch(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
  text: string,
) {
  return Effect.gen(function* () {
    fixture.setNextHookVerdict({ decision: "grant" });
    const conversationId = yield* createModeratedDm(alice, bob, TEST_APP_ID);
    // Fork-before-trigger (Spec B #596 r2 fix).
    const releaseFiber = yield* waitForDispatchRelease(bob);
    const ack = yield* requestDispatch(bob, conversationId, alice, text);
    yield* Fiber.join(releaseFiber);
    return { ack, conversationId };
  }).pipe(Effect.withSpan("requestGrantedModeratedDispatch"));
}

function requestGrantedUnmoderatedDispatch(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
  text: string,
) {
  return Effect.gen(function* () {
    const conversationId = yield* createUnmoderatedDm(alice, bob);
    // Fork-before-trigger (Spec B #596 r2 fix).
    const releaseFiber = yield* waitForDispatchRelease(bob);
    const ack = yield* requestDispatch(bob, conversationId, alice, text);
    yield* Fiber.join(releaseFiber);
    return { ack, conversationId };
  }).pipe(Effect.withSpan("requestGrantedUnmoderatedDispatch"));
}

function sendWithLeaseRejected(
  bob: ConnectedAgent,
  conversationId: ConversationId,
  leaseId: Parameters<typeof sendMessageWithLease>[2],
  text: string,
) {
  return Effect.either(
    sendMessageWithLease(bob, conversationId, leaseId, text),
  );
}

function pendingLeaseRejectsSend() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const { ack, conversationId } = yield* requestPendingModeratedDispatch(
      alice,
      bob,
    );
    const result = yield* sendWithLeaseRejected(
      bob,
      conversationId,
      ack.leaseId,
      "race",
    );
    expectEitherLeft(result);
  });
}

function grantedLeaseIsSingleUse() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const { ack, conversationId } = yield* requestGrantedUnmoderatedDispatch(
      alice,
      bob,
      "first",
    );
    const first = yield* sendMessageWithLease(
      bob,
      conversationId,
      ack.leaseId,
      "first",
    );
    expect(typeof first.message.id).toBe(EXPECTED_TYPE_STRING);

    const second = yield* sendWithLeaseRejected(
      bob,
      conversationId,
      ack.leaseId,
      "second",
    );
    expectEitherLeft(second);
  });
}

function insertFailureRollsBackLease() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const { ack, conversationId } = yield* requestGrantedUnmoderatedDispatch(
      alice,
      bob,
      "probe",
    );
    yield* alice.client.sendRpc(ConversationsArchive, { conversationId });

    const sendResult = yield* sendWithLeaseRejected(
      bob,
      conversationId,
      ack.leaseId,
      "probe",
    );
    expectEitherLeft(sendResult);

    const record = yield* readLeaseByLeaseId(ack.leaseId);
    expect(record.state).toBe(DISPATCH_STATE_GRANTED);
  });
}

function postInsertDurabilityHappyPath() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const { ack, conversationId } = yield* requestGrantedUnmoderatedDispatch(
      alice,
      bob,
      "first",
    );
    const first = yield* sendMessageWithLease(
      bob,
      conversationId,
      ack.leaseId,
      "first",
    );

    const record = yield* readLeaseByLeaseId(ack.leaseId);
    expect(record.state).toBe(DISPATCH_STATE_CONSUMED);
    expect(record.consumedMessageId).toBe(first.message.id);

    const retry = yield* sendWithLeaseRejected(
      bob,
      conversationId,
      ack.leaseId,
      "retry",
    );
    expectEitherLeft(retry);
  });
}

function postInsertFailureKeepsLeaseConsumed() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const { ack, conversationId } = yield* requestGrantedModeratedDispatch(
      alice,
      bob,
      "first",
    );

    yield* alice.client.close();
    yield* Effect.sleep("300 millis");

    const sendResult = yield* sendWithLeaseRejected(
      bob,
      conversationId,
      ack.leaseId,
      "first",
    );
    expectEitherLeft(sendResult);

    const record = yield* readLeaseByLeaseId(ack.leaseId);
    expect(record.state).toBe(DISPATCH_STATE_CONSUMED);
    expect(record.consumedMessageId).not.toBeNull();

    const retry = yield* sendWithLeaseRejected(
      bob,
      conversationId,
      ack.leaseId,
      "retry",
    );
    expectEitherLeft(retry);
  });
}

describe("dispatch/* - single-use lease preconditions", () => {
  it(
    "rejects messages/send while dispatch lease is still pending",
    pendingLeaseRejectsSend,
    25_000,
  );

  it(
    "rejects a second messages/send for a consumed lease",
    grantedLeaseIsSingleUse,
    20_000,
  );

  it(
    "rolls the lease back to granted when message insert fails",
    insertFailureRollsBackLease,
    20_000,
  );
});

describe("dispatch/* - post-insert durability", () => {
  it(
    "leaves the lease consumed with a durable row after successful send",
    postInsertDurabilityHappyPath,
    20_000,
  );

  it(
    "keeps the lease consumed when commit side effects fail after finalize",
    postInsertFailureKeepsLeaseConsumed,
    25_000,
  );
});
