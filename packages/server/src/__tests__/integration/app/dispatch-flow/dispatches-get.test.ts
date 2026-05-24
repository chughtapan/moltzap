/**
 * #529 reshape additive — `dispatch/{request, authorize, release}` +
 * `dispatches/{consumed, expired, get}` admission surface.
 *
 * Bucket file: `dispatches-get` group. Split from `dispatch-flow.integration.test.ts`
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
import {
  DispatchAuthorize,
  DispatchesGet,
  TaskCreate,
  type AppManifest,
  type DispatchId,
} from "@moltzap/protocol";
import { Effect, Fiber } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  DISPATCH_RELEASE_TIMEOUT_MS,
  DISPATCH_STATE_GRANTED,
  attachDispatchAuthorizeHook,
  createTaskConversationOnApp,
  createUnmoderatedDm,
  createDispatchFlowFixture,
  readLeaseByDispatchId,
  requestDispatch,
  startDispatchFlowServer,
  stopDispatchFlowServer,
  waitForDispatchRelease,
} from "./fixture.js";
import {
  expectEitherLeft,
  registerAndConnect,
  setupAgentPair,
  type ConnectedAgent,
} from "../../helpers.js";

const it = effectIt.live;

const TEST_APP_ID = "00000000-0000-4000-8000-000000010001";
const WIRE_APP_ID = "00000000-0000-4000-8000-000000010003";

const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Moderator Dispatch Test App",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

const WIRE_APP_MANIFEST: AppManifest = {
  appId: WIRE_APP_ID,
  name: "Wire Moderator Dispatch App",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
  hooks: {
    dispatch_authorize: { timeout_ms: DISPATCH_RELEASE_TIMEOUT_MS },
  },
};

const fixture = createDispatchFlowFixture(TEST_APP_MANIFEST);

beforeAll(startDispatchFlowServer, 60_000);

afterAll(stopDispatchFlowServer);

beforeEach(() => Effect.runPromise(fixture.reset));

function grantDispatchAuthorize() {
  return Effect.succeed({
    admission: { decision: "grant" as const },
  });
}

function registerWireModerator() {
  return Effect.gen(function* () {
    const moderator = yield* registerAndConnect("wire-moderator");
    yield* moderator.client.onAppCallback(
      DispatchAuthorize,
      grantDispatchAuthorize,
    );
    yield* moderator.client.onAppCallback(TaskCreate, () =>
      Effect.succeed({ verdict: { decision: "accept" as const } }),
    );
    // AppsRegister is driven by `createTaskConversationOnApp`'s
    // idempotent `ensureModeratorAppRegistered` — calling it here
    // would double-register, which the server now strictly rejects.
    return moderator;
  });
}

function requestWireModeratedDispatch(
  moderator: ConnectedAgent,
  recipient: ConnectedAgent,
) {
  return Effect.gen(function* () {
    const { conversationId } = yield* createTaskConversationOnApp(
      moderator,
      recipient,
      WIRE_APP_MANIFEST,
    );
    // Fork-before-trigger (Spec B #596 r2 fix).
    const releaseFiber = yield* waitForDispatchRelease(
      recipient,
      DISPATCH_RELEASE_TIMEOUT_MS,
    );
    const ack = yield* requestDispatch(
      recipient,
      conversationId,
      moderator,
      "wire",
    );
    const release = yield* Fiber.join(releaseFiber);
    expect(release.leaseId).toBe(ack.leaseId);
    return ack;
  });
}

function registryDirectReadShowsGrantedLease() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    fixture.setNextHookVerdict({ decision: "grant" });
    yield* attachDispatchAuthorizeHook(alice, fixture);
    const { conversationId } = yield* createTaskConversationOnApp(
      alice,
      bob,
      TEST_APP_MANIFEST,
    );
    const releaseFiber = yield* waitForDispatchRelease(
      bob,
      DISPATCH_RELEASE_TIMEOUT_MS,
    );
    const ack = yield* requestDispatch(bob, conversationId, alice);
    yield* Fiber.join(releaseFiber);

    const record = yield* readLeaseByDispatchId(ack.dispatchId as DispatchId);
    expect(record.dispatchId).toBe(ack.dispatchId);
    expect(record.leaseId).toBe(ack.leaseId);
    expect(record.state).toBe(DISPATCH_STATE_GRANTED);
  });
}

function nonModeratorCannotReadDispatch() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const { conversationId } = yield* createUnmoderatedDm(alice, bob);
    const ack = yield* requestDispatch(bob, conversationId, alice);
    const result = yield* Effect.either(
      bob.client.sendRpc(DispatchesGet, {
        dispatchId: ack.dispatchId as DispatchId,
      }),
    );
    expectEitherLeft(result);
  });
}

function wireModeratorReadsGrantedLease() {
  return Effect.gen(function* () {
    const moderator = yield* registerWireModerator();
    const recipient = yield* registerAndConnect("wire-recipient");
    const ack = yield* requestWireModeratedDispatch(moderator, recipient);

    const view = yield* moderator.client.sendRpc(DispatchesGet, {
      dispatchId: ack.dispatchId as DispatchId,
    });
    expect(view.lease.dispatchId).toBe(ack.dispatchId);
    expect(view.lease.leaseId).toBe(ack.leaseId);
    expect(view.lease.state).toBe(DISPATCH_STATE_GRANTED);
  });
}

describe("dispatch/* — dispatches/get reads (#529 reshape additive)", () => {
  it(
    "dispatches/get happy path: granted lease is readable with state=GRANTED",
    registryDirectReadShowsGrantedLease,
    20_000,
  );

  it(
    "dispatches/get scope enforcement: non-governing app gets typed ForbiddenError",
    nonModeratorCannotReadDispatch,
    20_000,
  );

  it(
    "dispatches/get wire happy path: moderator over WS reads its lease record at GRANTED stage",
    wireModeratorReadsGrantedLease,
    25_000,
  );
});
