/**
 * #529 reshape additive: dispatch admission lease lifecycle behavior.
 */
import { it as effectIt } from "@effect/vitest";
import { type AppManifest } from "@moltzap/protocol";
import { Effect, Fiber } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  DISPATCH_STATE_ABANDONED,
  DISPATCH_STATE_CONSUMED,
  DISPATCH_STATE_EXPIRED,
  DISPATCH_STATE_GRANTED,
  DISPATCH_VERDICT_HOLD,
  MODERATOR_UNAVAILABLE_REASON,
  createDispatchFlowFixture,
  createModeratedDm,
  createUnmoderatedDm,
  readLeaseByDispatchId,
  readLeaseByLeaseId,
  requestDispatch,
  sendMessageWithLease,
  startDispatchFlowServer,
  stopDispatchFlowServer,
  waitForDispatchRelease,
  waitForParticipantsRemoved,
} from "./fixture.js";
import {
  expectEitherLeft,
  registerAndConnect,
  setupAgentPair,
  type ConnectedAgent,
} from "../../helpers.js";

const it = effectIt.live;

const TEST_APP_ID = "moderator-dispatch-test-app";
const UNKNOWN_APP_ID = "no-hook-dispatch-app";
const SHORT_LEASE_TIMEOUT_MS = 100;
const PARTICIPANT_REMOVED_NEGATIVE_WAIT_MS = 500;
const DISCONNECT_FINALIZER_WAIT = "300 millis";
const TTL_WAIT = "400 millis";

const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Moderator Dispatch Test App",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

const fixture = createDispatchFlowFixture(TEST_APP_MANIFEST);

beforeAll(startDispatchFlowServer, 60_000);

afterAll(stopDispatchFlowServer);

beforeEach(() => Effect.runPromise(fixture.reset));

function requestModeratedDispatch(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
  appId: string,
  text: string,
) {
  return Effect.gen(function* () {
    const binding = yield* createModeratedDm(alice, bob, appId);
    const ack = yield* requestDispatch(
      bob,
      binding.conversationId,
      alice,
      text,
    );
    return { ack, binding, conversationId: binding.conversationId };
  }).pipe(Effect.withSpan("requestModeratedLifecycleDispatch"));
}

function requestUnmoderatedDispatch(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
  text: string,
) {
  return Effect.gen(function* () {
    const binding = yield* createUnmoderatedDm(alice, bob);
    const ack = yield* requestDispatch(
      bob,
      binding.conversationId,
      alice,
      text,
    );
    return { ack, binding, conversationId: binding.conversationId };
  }).pipe(Effect.withSpan("requestUnmoderatedLifecycleDispatch"));
}

function synthesizedInfraHoldDoesNotRemoveRecipient() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    // Fork-before-trigger (Spec B #596 r2 fix): subscribe before the
    // dispatch RPC fires. The participants/removed listener is also
    // forked up-front so a stray event would still be captured; the
    // assertion is `expectEitherLeft` (timeout) since infra-hold must
    // NOT remove the recipient.
    const releaseFiber = yield* waitForDispatchRelease(bob);
    const removedFiber = yield* waitForParticipantsRemoved(
      bob,
      PARTICIPANT_REMOVED_NEGATIVE_WAIT_MS,
    );
    const { ack } = yield* requestModeratedDispatch(
      alice,
      bob,
      UNKNOWN_APP_ID,
      "probe",
    );
    const release = yield* Fiber.join(releaseFiber);

    expect(release.leaseId).toBe(ack.leaseId);
    expect(release.verdict.decision).toBe(DISPATCH_VERDICT_HOLD);
    expect(release.verdict.reason).toBe(MODERATOR_UNAVAILABLE_REASON);

    const removed = yield* Effect.either(Fiber.join(removedFiber));
    expectEitherLeft(removed);
  });
}

function grantedLeaseExpiresAfterTtl() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    fixture.setNextHookVerdict({
      decision: "grant",
      leaseTimeoutMs: SHORT_LEASE_TIMEOUT_MS,
    });
    const releaseFiber = yield* waitForDispatchRelease(bob);
    const { ack } = yield* requestModeratedDispatch(
      alice,
      bob,
      TEST_APP_ID,
      "probe",
    );

    yield* Fiber.join(releaseFiber);
    yield* Effect.sleep(TTL_WAIT);

    const record = yield* readLeaseByDispatchId(ack.dispatchId);
    expect(record.state).toBe(DISPATCH_STATE_EXPIRED);
  });
}

function pendingDisconnectAbandonsLease() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    fixture.setNextHookVerdict({ kind: "never-reply" });
    const { ack } = yield* requestModeratedDispatch(
      alice,
      bob,
      TEST_APP_ID,
      "abandon",
    );

    yield* bob.client.close();
    yield* Effect.sleep(DISCONNECT_FINALIZER_WAIT);

    const record = yield* readLeaseByLeaseId(ack.leaseId);
    expect(record.state).toBe(DISPATCH_STATE_ABANDONED);
  });
}

function grantedDisconnectExpiresLease() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const releaseFiber = yield* waitForDispatchRelease(bob);
    const { ack } = yield* requestUnmoderatedDispatch(alice, bob, "probe");
    yield* Fiber.join(releaseFiber);

    const granted = yield* readLeaseByLeaseId(ack.leaseId);
    expect(granted.state).toBe(DISPATCH_STATE_GRANTED);

    yield* bob.client.close();
    yield* Effect.sleep(DISCONNECT_FINALIZER_WAIT);

    const expired = yield* readLeaseByLeaseId(ack.leaseId);
    expect(expired.state).toBe(DISPATCH_STATE_EXPIRED);
  });
}

function consumedDisconnectKeepsLeaseConsumed() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const releaseFiber = yield* waitForDispatchRelease(bob);
    const { ack, binding } = yield* requestUnmoderatedDispatch(
      alice,
      bob,
      "first",
    );
    yield* Fiber.join(releaseFiber);
    const sent = yield* sendMessageWithLease(
      bob,
      binding,
      ack.leaseId,
      "first",
    );

    const consumed = yield* readLeaseByLeaseId(ack.leaseId);
    expect(consumed.state).toBe(DISPATCH_STATE_CONSUMED);

    yield* bob.client.close();
    yield* Effect.sleep(DISCONNECT_FINALIZER_WAIT);

    const after = yield* readLeaseByLeaseId(ack.leaseId);
    expect(after.state).toBe(DISPATCH_STATE_CONSUMED);
    expect(after.consumedMessageId).toBe(sent.message.id);
  });
}

function expiredReconnectMintsNewLease() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    fixture.setNextHookVerdict({
      decision: "grant",
      leaseTimeoutMs: SHORT_LEASE_TIMEOUT_MS,
    });
    const releaseFiber = yield* waitForDispatchRelease(bob);
    const first = yield* requestModeratedDispatch(
      alice,
      bob,
      TEST_APP_ID,
      "first",
    );
    yield* Fiber.join(releaseFiber);
    yield* Effect.sleep(TTL_WAIT);

    const expired = yield* readLeaseByLeaseId(first.ack.leaseId);
    expect(expired.state).toBe(DISPATCH_STATE_EXPIRED);

    yield* bob.client.close();
    const bob2 = yield* registerAndConnect("bob2");
    fixture.setNextHookVerdict({ decision: "grant" });
    const second = yield* requestModeratedDispatch(
      alice,
      bob2,
      TEST_APP_ID,
      "second",
    );

    expect(second.ack.leaseId).not.toBe(first.ack.leaseId);
    expect(second.ack.dispatchId).not.toBe(first.ack.dispatchId);
  });
}

describe("dispatch/* - lifecycle verdict and ttl", () => {
  it(
    "does not remove the recipient for synthesized infra hold",
    synthesizedInfraHoldDoesNotRemoveRecipient,
    20_000,
  );

  it(
    "expires a granted lease after leaseTimeoutMs",
    grantedLeaseExpiresAfterTtl,
    20_000,
  );
});

describe("dispatch/* - lifecycle connection close", () => {
  it(
    "abandons a pending lease when the recipient disconnects",
    pendingDisconnectAbandonsLease,
    20_000,
  );

  it(
    "expires a granted lease when the recipient disconnects",
    grantedDisconnectExpiresLease,
    20_000,
  );

  it(
    "keeps a consumed lease consumed after recipient disconnect",
    consumedDisconnectKeepsLeaseConsumed,
    20_000,
  );
});

describe("dispatch/* - lifecycle reconnect", () => {
  it(
    "mints a new lease after the previous lease expired",
    expiredReconnectMintsNewLease,
    25_000,
  );
});
