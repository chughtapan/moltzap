/**
 * `agent/dispatch/request`, `app/dispatch/authorize`,
 * `agent/dispatch/released`, and `app/dispatch/lease-*` admission surface.
 *
 * Bucket file: `dispatch-lease-get` group. Each bucket owns its own server fixture
 * so vitest can execute buckets concurrently without sharing state.
 *
 * The recipient calls `agent/dispatch/request` over WS; server mints a lease, returns ack
 * synchronously, forks the moderator round-trip; recipient observes
 * the verdict via `agent/dispatch/released` notification. `agent/message/send(
 * dispatchLeaseId=X)` consumes the lease via `Effect.acquireUseRelease(
 * claim, sendInsert+commit, finalize|rollback)`.
 */
import { it as effectIt } from "@effect/vitest";
import { DispatchLeaseGet } from "@moltzap/protocol/message/dispatch";
import type { AppManifest } from "@moltzap/protocol/identity";
import type { DispatchId } from "@moltzap/protocol/message/dispatch";
import { Effect, Fiber } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import {
  DISPATCH_RELEASE_TIMEOUT_MS,
  DISPATCH_STATE_GRANTED,
  attachDispatchAuthorizeHook,
  createConversationOnApp,
  createDispatchFlowFixture,
  MODERATED_HOOKS,
  moderatorAppClient,
  readLeaseByDispatchId,
  requestDispatch,
  startDispatchFlowServer,
  stopDispatchFlowServer,
  waitForDispatchRelease,
} from "./fixture.js";
import {
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
  hooks: MODERATED_HOOKS,
};

const WIRE_APP_MANIFEST: AppManifest = {
  appId: WIRE_APP_ID,
  name: "Wire Moderator Dispatch App",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
  hooks: {
    dispatch_authorize: {
      kind: "hook",
      timeoutMs: DISPATCH_RELEASE_TIMEOUT_MS,
    },
    message_authorize: { kind: "forwardAllExceptSender" },
    task_create: { kind: "accept" },
  },
};

const fixture = createDispatchFlowFixture(TEST_APP_MANIFEST);

beforeAll(startDispatchFlowServer, 60_000);

afterAll(stopDispatchFlowServer);

beforeEach(() => Effect.runPromise(fixture.reset));

function requestWireModeratedDispatch(
  requester: ConnectedAgent,
  recipient: ConnectedAgent,
) {
  return Effect.gen(function* () {
    // The grant verdict is answered by the fixture's moderator
    // `AppConnection` (a disjoint principal from `requester`), armed via the
    // fixture hook. `WIRE_APP_MANIFEST`'s `kind: "hook"` dispatch policy
    // routes the admission decision to that connection rather than resolving
    // a static verdict in-process.
    fixture.setNextHookVerdict({ decision: "grant" });
    yield* attachDispatchAuthorizeHook(requester, fixture);
    const { conversationId } = yield* createConversationOnApp(
      requester,
      recipient,
      WIRE_APP_MANIFEST,
    );
    // Subscribe before the trigger RPC so the release notification is observed.
    const releaseFiber = yield* waitForDispatchRelease(
      recipient,
      DISPATCH_RELEASE_TIMEOUT_MS,
    );
    const ack = yield* requestDispatch(
      recipient,
      conversationId,
      requester,
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
    const { conversationId } = yield* createConversationOnApp(
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

function wireModeratorReadsGrantedLease() {
  return Effect.gen(function* () {
    const requester = yield* registerAndConnect("wire-requester");
    const recipient = yield* registerAndConnect("wire-recipient");
    const ack = yield* requestWireModeratedDispatch(requester, recipient);

    // `app/dispatch/lease/get` is moderator-scoped: only the lease's
    // `moderatorConnectionId` (the fixture's app `AppConnection`) may read it.
    const view = yield* moderatorAppClient().sendRpc(DispatchLeaseGet, {
      dispatchId: ack.dispatchId as DispatchId,
    });
    expect(view.lease.dispatchId).toBe(ack.dispatchId);
    expect(view.lease.leaseId).toBe(ack.leaseId);
    expect(view.lease.state).toBe(DISPATCH_STATE_GRANTED);
  });
}

describe("dispatch/* — app/dispatch/lease/get reads", () => {
  it(
    "app/dispatch/lease/get happy path: granted lease is readable with state=GRANTED",
    registryDirectReadShowsGrantedLease,
    20_000,
  );

  it(
    "app/dispatch/lease/get wire happy path: moderator over WS reads its lease record at GRANTED stage",
    wireModeratorReadsGrantedLease,
    25_000,
  );
});
