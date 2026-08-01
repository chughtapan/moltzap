/**
 * Dispatch admission single-use lease behavior.
 */
import { it as effectIt } from "@effect/vitest";
import { ConversationUpdate } from "@moltzap/protocol/conversation";
import type { AppManifest } from "@moltzap/protocol/identity";
import type { LeaseId } from "@moltzap/protocol/message/dispatch";
import { Effect, Fiber } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  attachDispatchAuthorizeHook,
  type ConversationBinding,
  createConversationOnApp,
  createDispatchFlowFixture,
  DISPATCH_STATE_CONSUMED,
  DISPATCH_STATE_GRANTED,
  EXPECTED_TYPE_STRING,
  MODERATED_HOOKS,
  moderatorAppClient,
  readLeaseByLeaseId,
  requestDispatch,
  sendMessageWithLease,
  startDispatchFlowServer,
  stopDispatchFlowServer,
  waitForDispatchRelease,
} from "./fixture.js";
import {
  type ConnectedAgent,
  expectEitherLeft,
  setupAgentPair,
} from "../../helpers.js";

const it = effectIt.live;

const TEST_APP_ID = "00000000-0000-4000-8000-000000010001";

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

function requestPendingModeratedDispatch(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
) {
  return Effect.gen(function* () {
    fixture.setNextHookVerdict({ kind: "never-reply" });
    yield* attachDispatchAuthorizeHook(alice, fixture);
    const binding = yield* createConversationOnApp(
      alice,
      bob,
      TEST_APP_MANIFEST,
    );
    const ack = yield* requestDispatch(
      bob,
      binding.conversationId,
      alice,
      "race",
    );
    return { ack, binding };
  }).pipe(Effect.withSpan("requestPendingModeratedDispatch"));
}

function requestGrantedModeratedDispatch(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
  text: string,
) {
  return Effect.gen(function* () {
    fixture.setNextHookVerdict({ decision: "grant" });
    yield* attachDispatchAuthorizeHook(alice, fixture);
    const binding = yield* createConversationOnApp(
      alice,
      bob,
      TEST_APP_MANIFEST,
    );
    // Subscribe before the trigger RPC so the release notification is observed.
    const releaseFiber = yield* waitForDispatchRelease(bob);
    const ack = yield* requestDispatch(
      bob,
      binding.conversationId,
      alice,
      text,
    );
    yield* Fiber.join(releaseFiber);
    return { ack, binding };
  }).pipe(Effect.withSpan("requestGrantedModeratedDispatch"));
}

function sendWithLeaseRejected(
  bob: ConnectedAgent,
  binding: ConversationBinding,
  leaseId: LeaseId,
  text: string,
) {
  return Effect.either(sendMessageWithLease(bob, binding, leaseId, text));
}

function pendingLeaseRejectsSend() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const { ack, binding } = yield* requestPendingModeratedDispatch(alice, bob);
    const result = yield* sendWithLeaseRejected(
      bob,
      binding,
      ack.leaseId,
      "race",
    );
    expectEitherLeft(result);
  });
}

function grantedLeaseIsSingleUse() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const { ack, binding } = yield* requestGrantedModeratedDispatch(
      alice,
      bob,
      "first",
    );
    const first = yield* sendMessageWithLease(
      bob,
      binding,
      ack.leaseId,
      "first",
    );
    expect(typeof first.message.id).toBe(EXPECTED_TYPE_STRING);

    const second = yield* sendWithLeaseRejected(
      bob,
      binding,
      ack.leaseId,
      "second",
    );
    expectEitherLeft(second);
  });
}

function insertFailureRollsBackLease() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    // The moderated path binds the task to the fixture's app connection.
    // Archiving from that app client forces the subsequent agent/message/send to
    // fail at insert time.
    const { ack, binding } = yield* requestGrantedModeratedDispatch(
      alice,
      bob,
      "probe",
    );
    yield* moderatorAppClient().sendRpc(ConversationUpdate, {
      action: "archive",
      taskId: binding.taskId,
      conversationId: binding.conversationId,
    });

    const sendResult = yield* sendWithLeaseRejected(
      bob,
      binding,
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
    const { ack, binding } = yield* requestGrantedModeratedDispatch(
      alice,
      bob,
      "first",
    );
    const first = yield* sendMessageWithLease(
      bob,
      binding,
      ack.leaseId,
      "first",
    );

    const record = yield* readLeaseByLeaseId(ack.leaseId);
    expect(record.state).toBe(DISPATCH_STATE_CONSUMED);
    expect(record.consumedMessageId).toBe(first.message.id);

    const retry = yield* sendWithLeaseRejected(
      bob,
      binding,
      ack.leaseId,
      "retry",
    );
    expectEitherLeft(retry);
  });
}

function postInsertFailureKeepsLeaseConsumed() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const { ack, binding } = yield* requestGrantedModeratedDispatch(
      alice,
      bob,
      "first",
    );

    // Drop the moderator app connection so the post-finalize side effect fails
    // while the committed lease remains consumed.
    yield* moderatorAppClient().close();
    yield* Effect.sleep("300 millis");

    const sendResult = yield* sendWithLeaseRejected(
      bob,
      binding,
      ack.leaseId,
      "first",
    );
    expectEitherLeft(sendResult);

    const record = yield* readLeaseByLeaseId(ack.leaseId);
    expect(record.state).toBe(DISPATCH_STATE_CONSUMED);
    expect(record.consumedMessageId).not.toBeNull();

    const retry = yield* sendWithLeaseRejected(
      bob,
      binding,
      ack.leaseId,
      "retry",
    );
    expectEitherLeft(retry);
  });
}

describe("dispatch/* - single-use lease preconditions", () => {
  it(
    "rejects agent/message/send while dispatch lease is still pending",
    pendingLeaseRejectsSend,
    25_000,
  );

  it(
    "rejects a second agent/message/send for a consumed lease",
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
