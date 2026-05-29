/**
 * Gating tests for the AppHost remote-app routing surface (architect
 * plan §3.4). The dispatch helpers and registration paths exercised
 * here cover the single `dispatch/authorize` server→client round-trip.
 *
 * Tests run against a fake wire `{ id, originator }` directly (no
 * testcontainers, no real WS) so they stay pure-Effect — `TestClock`-drivable,
 * no real sleeps. The originator's `write` records outbound frames; the test
 * synthesizes inbound responses by calling `conn.originator.resolve`
 * (the same path the server's read fiber uses).
 */
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vitest";
import { Data, Effect, Exit, Fiber, Ref, Scope } from "effect";
import {
  DispatchAuthorize,
  MessagesAuthorize,
  NotConnectedError,
  type AppManifest,
  type JsonRpcId,
} from "@moltzap/protocol";
import { makeStubConnection } from "./loopback-connection.js";
import type { AppEndpoint } from "./app-registration.js";
import {
  agentId,
  appId as makeAppId,
  connectionId as makeConnectionId,
  conversationId,
  messageId,
  taskId as makeTaskId,
  validateRequestFrame,
} from "@moltzap/protocol/testing";
import type { ConnectionId } from "@moltzap/protocol/network";
import type * as Socket from "@effect/platform/Socket";
import {
  acquireConnectionRpcClient,
  ConnectionManager,
  type Originator,
} from "../transport/connection.js";
import type { Db } from "../db/client.js";
import { makeFakeService } from "../test-utils/fakes.js";
import { AppHost } from "./app-host.js";
import type {
  MessageAuthorizeContext,
  DispatchAuthorizeContext,
} from "./types.js";

const liveIt = effectIt.live;

// ─────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimal fake wire connection: the `{ id, originator }` the test registers
 * (as an `AppEndpoint`) plus drives response synthesis through. The legacy
 * `MoltZapConnection` shape was deleted at CP4f; the test never read anything
 * else off it.
 */
interface FakeWireConn {
  readonly id: ConnectionId;
  readonly originator: Originator;
}

interface FakeConn {
  readonly conn: FakeWireConn;
  readonly outbound: Ref.Ref<ReadonlyArray<string>>;
}

/**
 * Build a real wire {@link Originator} whose `write` records outbound frames
 * into a Ref. Caller can `JSON.parse` the captured frame to get the request
 * id, then synthesize a matching response via `conn.originator.resolve`. The
 * Originator's Scope finalizer fails every still-pending call with
 * `NotConnectedError` when the surrounding scope closes — close to drive the
 * disconnect path.
 */
const makeFakeConnection = (
  connId: ConnectionId,
): Effect.Effect<FakeConn, never, Scope.Scope> =>
  Effect.gen(function* () {
    const outbound = yield* Ref.make<ReadonlyArray<string>>([]);
    const write = (raw: string): Effect.Effect<void, Socket.SocketError> =>
      Ref.update(outbound, (xs) => [...xs, raw]);
    const originator = yield* acquireConnectionRpcClient(connId, write);
    return { conn: { id: connId, originator }, outbound };
  });

const stubConnection = (connId: ConnectionId): AppEndpoint =>
  makeStubConnection({ id: connId });

/**
 * Stub endpoint whose `originator.call` always fails with
 * `NotConnectedError`. Mimics the "registration outlives its
 * connection" scenario (e.g., the WS dropped after AppsRegister
 * succeeded but before the cleanup finalizer ran).
 */
const staleConnection = (connId: ConnectionId): AppEndpoint =>
  makeStubConnection({
    id: connId,
    originatorCall: () =>
      Effect.fail(
        new NotConnectedError({ message: `connection ${connId} is stale` }),
      ),
  });

interface AppHostFixture {
  readonly host: AppHost;
  readonly connections: ConnectionManager;
}

function makeAppHostFixture(): AppHostFixture {
  const connections = new ConnectionManager();
  const db = makeFakeService<Db>({} as Partial<Db>);
  const host = new AppHost(db, connections);
  return { host, connections };
}

// Always declares `dispatch_authorize` so these tests exercise the
// remote dispatch round-trip. D #705 CP8 added a manifest-default
// fast-path: a manifest that OMITS `dispatch_authorize` is served the
// synthetic `grant` server-side (no app dispatch), so a hookless
// manifest would never reach the stub connection's originator.
const baseManifest = (
  manifestAppId: string,
  hookTimeoutMs?: number,
): AppManifest => ({
  appId: manifestAppId,
  name: `Test App ${manifestAppId}`,
  conversations: [],
  hooks: {
    dispatch_authorize:
      hookTimeoutMs === undefined ? {} : { timeout_ms: hookTimeoutMs },
  },
});

const messageAuthorizeManifest = (
  manifestAppId: string,
  hookTimeoutMs?: number,
): AppManifest => ({
  appId: manifestAppId,
  name: `Test App ${manifestAppId}`,
  conversations: [],
  hooks: {
    message_authorize:
      hookTimeoutMs === undefined ? {} : { timeout_ms: hookTimeoutMs },
  },
});

const FIXTURE_CONVERSATION_ID = conversationId(
  "00000000-0000-4000-8000-000000000c01",
);
const FIXTURE_AGENT_RECIPIENT = agentId("00000000-0000-4000-8000-000000000a01");
const FIXTURE_AGENT_SENDER = agentId("00000000-0000-4000-8000-000000000a02");
const FIXTURE_MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000201");
const MESSAGE_APP_ID = makeAppId("00000000-0000-4000-8000-000000000560");
const APP_R = makeAppId("00000000-0000-4000-8000-000000000570");
const APP_NEVER = makeAppId("00000000-0000-4000-8000-000000000572");
const CONN_NO_SUCH = makeConnectionId("no-such-conn");
const CONN_1 = makeConnectionId("conn-1");
const CONN_2 = makeConnectionId("conn-2");
const CONN_RM_1 = makeConnectionId("conn-rm-1");
const CONN_RM_DECODE = makeConnectionId("conn-rm-decode");
const CONN_RD_1 = makeConnectionId("conn-rd-1");
const CONN_RD_DENY = makeConnectionId("conn-rd-deny");
const CONN_RD_DROP = makeConnectionId("conn-rd-drop");
const CONN_RD_DECODE = makeConnectionId("conn-rd-decode");

const baseAuthorizeDispatchCtx = (
  appId: string,
  taskId: ReturnType<typeof makeTaskId>,
): DispatchAuthorizeContext => ({
  conversationId: FIXTURE_CONVERSATION_ID,
  recipient: { agentId: FIXTURE_AGENT_RECIPIENT, ownerId: "owner-r" },
  message: { id: FIXTURE_MESSAGE_ID, senderAgentId: FIXTURE_AGENT_SENDER },
  taskId,
  appId,
  attempt: 0,
});

const baseMessageAuthorizeCtx = (
  appId: string,
  taskId: ReturnType<typeof makeTaskId>,
): MessageAuthorizeContext => ({
  conversationId: FIXTURE_CONVERSATION_ID,
  message: {
    id: FIXTURE_MESSAGE_ID,
    senderAgentId: FIXTURE_AGENT_SENDER,
    parts: [{ type: "text", text: "moderate me" }],
  },
  taskId,
  appId,
  receivedAt: "2026-05-12T00:00:00.000Z",
});

/** Decode the most recently captured outbound frame from a fake connection. */
class CaptureRequestError extends Data.TaggedError("CaptureRequestError")<{
  readonly message: string;
  readonly reason: "empty" | "invalid";
}> {}

function captureLatestRequestId(
  outbound: Ref.Ref<ReadonlyArray<string>>,
): Effect.Effect<JsonRpcId, CaptureRequestError> {
  return Effect.gen(function* () {
    const xs = yield* Ref.get(outbound);
    if (xs.length === 0) {
      return yield* Effect.fail(
        new CaptureRequestError({
          message: "no outbound frame yet",
          reason: "empty",
        }),
      );
    }
    const parsed: unknown = JSON.parse(xs[xs.length - 1]!);
    if (!validateRequestFrame(parsed)) {
      return yield* Effect.fail(
        new CaptureRequestError({
          message: "expected JSON-RPC request frame",
          reason: "invalid",
        }),
      );
    }
    return parsed.id;
  });
}

interface CapturedRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

function captureLatestRequest(
  outbound: Ref.Ref<ReadonlyArray<string>>,
): Effect.Effect<CapturedRequest, CaptureRequestError> {
  return Effect.gen(function* () {
    const xs = yield* Ref.get(outbound);
    if (xs.length === 0) {
      return yield* Effect.fail(
        new CaptureRequestError({
          message: "no outbound frame yet",
          reason: "empty",
        }),
      );
    }
    const parsed: unknown = JSON.parse(xs[xs.length - 1]!);
    if (!validateRequestFrame(parsed)) {
      return yield* Effect.fail(
        new CaptureRequestError({
          message: "expected JSON-RPC request frame",
          reason: "invalid",
        }),
      );
    }
    const frame = parsed as {
      readonly id: JsonRpcId;
      readonly method: string;
      readonly params: unknown;
    };
    return { id: frame.id, method: frame.method, params: frame.params };
  });
}

function waitForLatestRequestId(outbound: Ref.Ref<ReadonlyArray<string>>) {
  return Effect.sleep("1 millis").pipe(
    Effect.zipRight(captureLatestRequestId(outbound)),
    Effect.retry({ times: 50 }),
  );
}

function waitForLatestRequest(outbound: Ref.Ref<ReadonlyArray<string>>) {
  return Effect.sleep("1 millis").pipe(
    Effect.zipRight(captureLatestRequest(outbound)),
    Effect.retry({ times: 50 }),
  );
}

function bindPrivateMethod<Fn extends (...args: never[]) => unknown>(
  target: object,
  key: string,
): Fn {
  const value = Reflect.get(target, key);
  if (typeof value !== "function") {
    throw new TypeError(`missing private method: ${key}`);
  }
  return value.bind(target) as Fn;
}

type AuthorizeDispatchDispatch = (
  appId: string,
  ctx: DispatchAuthorizeContext,
) => Effect.Effect<unknown, never>;

const dispatchAuthorizeDispatch = (host: AppHost): AuthorizeDispatchDispatch =>
  bindPrivateMethod(host, "dispatchAuthorizeHook");

function makeRemoteFixture(connectionId: ConnectionId, manifest: AppManifest) {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const fixture = makeAppHostFixture();
    const { conn, outbound } = yield* Scope.extend(
      makeFakeConnection(connectionId),
      scope,
    );
    fixture.host.registerApp(manifest, {
      connId: conn.id,
      originator: conn.originator,
    });
    return { ...fixture, conn, outbound, scope };
  }).pipe(Effect.withSpan("appHostTest.makeRemoteFixture"));
}

function expectMessageAuthorizeRequest(
  request: CapturedRequest,
  taskId: ReturnType<typeof makeTaskId>,
) {
  expect(request.method).toBe(String(MessagesAuthorize.name));
  expect(request.params).toEqual({
    taskId,
    appId: MESSAGE_APP_ID,
    conversationId: FIXTURE_CONVERSATION_ID,
    message: {
      id: FIXTURE_MESSAGE_ID,
      senderAgentId: FIXTURE_AGENT_SENDER,
      parts: [{ type: "text", text: "moderate me" }],
    },
    receivedAt: "2026-05-12T00:00:00.000Z",
  });
}

function remoteMessageAuthorizeForwards() {
  return Effect.gen(function* () {
    const fixture = yield* makeRemoteFixture(
      CONN_RM_1,
      messageAuthorizeManifest(MESSAGE_APP_ID),
    );
    const taskId = makeTaskId("00000000-0000-4000-8000-000000ce5601");
    const fiber = yield* Effect.fork(
      fixture.host.runMessageAuthorize(
        MESSAGE_APP_ID,
        baseMessageAuthorizeCtx(MESSAGE_APP_ID, taskId),
      ),
    );
    const request = yield* waitForLatestRequest(fixture.outbound);
    expectMessageAuthorizeRequest(request, taskId);

    yield* fixture.conn.originator.resolve(
      MessagesAuthorize.encodeResponse(request.id, {
        verdict: {
          decision: "Forward",
          recipients: [FIXTURE_AGENT_RECIPIENT],
        },
      }),
    );
    const verdict = yield* Fiber.join(fiber);
    yield* Scope.close(fixture.scope, Exit.void);
    expect(verdict).toEqual({
      decision: "Forward",
      recipients: [FIXTURE_AGENT_RECIPIENT],
    });
  });
}

function staleRemoteMessageBlocks() {
  return Effect.gen(function* () {
    const fixture = makeAppHostFixture();
    fixture.host.registerApp(
      messageAuthorizeManifest(MESSAGE_APP_ID),
      staleConnection(CONN_NO_SUCH),
    );
    const result = yield* fixture.host.runMessageAuthorize(
      MESSAGE_APP_ID,
      baseMessageAuthorizeCtx(
        MESSAGE_APP_ID,
        makeTaskId("00000000-0000-4000-8000-000000ce5602"),
      ),
    );
    expect(result).toEqual({ decision: "Block", reason: "tm_unreachable" });
  });
}

function malformedRemoteMessageBlocks() {
  return Effect.gen(function* () {
    const fixture = yield* makeRemoteFixture(
      CONN_RM_DECODE,
      messageAuthorizeManifest(MESSAGE_APP_ID),
    );
    const fiber = yield* Effect.fork(
      fixture.host.runMessageAuthorize(
        MESSAGE_APP_ID,
        baseMessageAuthorizeCtx(
          MESSAGE_APP_ID,
          makeTaskId("00000000-0000-4000-8000-000000ce5603"),
        ),
      ),
    );
    const id = yield* waitForLatestRequestId(fixture.outbound);
    yield* fixture.conn.originator.resolve(
      MessagesAuthorize.encodeResponse(id, { wrongShape: "nope" }),
    );
    const verdict = yield* Fiber.join(fiber);
    yield* Scope.close(fixture.scope, Exit.void);
    expect(verdict).toEqual({ decision: "Block", reason: "tm_unreachable" });
  });
}

function startRemoteDispatch(
  fixture: AppHostFixture,
  appId: string,
  taskId: ReturnType<typeof makeTaskId>,
) {
  const dispatch = dispatchAuthorizeDispatch(fixture.host);
  return dispatch(appId, baseAuthorizeDispatchCtx(appId, taskId));
}

function remoteDispatchGrantPassesThrough() {
  return Effect.gen(function* () {
    const fixture = yield* makeRemoteFixture(CONN_RD_1, baseManifest(APP_R));
    const fiber = yield* Effect.fork(
      startRemoteDispatch(
        fixture,
        APP_R,
        makeTaskId("00000000-0000-4000-8000-000000ce5510"),
      ),
    );
    const id = yield* waitForLatestRequestId(fixture.outbound);
    yield* fixture.conn.originator.resolve(
      DispatchAuthorize.encodeResponse(id, {
        admission: {
          decision: "grant",
          leaseId: "9b4f4f6f-7c95-4e36-9d3a-1f3e3c0d1a01",
        },
      }),
    );
    const verdict = yield* Fiber.join(fiber);
    yield* Scope.close(fixture.scope, Exit.void);
    expect(verdict).toEqual({
      decision: "grant",
      leaseId: "9b4f4f6f-7c95-4e36-9d3a-1f3e3c0d1a01",
    });
  });
}

function remoteDispatchDenyPassesThrough() {
  return Effect.gen(function* () {
    const fixture = yield* makeRemoteFixture(CONN_RD_DENY, baseManifest(APP_R));
    const fiber = yield* Effect.fork(
      startRemoteDispatch(
        fixture,
        APP_R,
        makeTaskId("00000000-0000-4000-8000-000000ce55d0"),
      ),
    );
    const id = yield* waitForLatestRequestId(fixture.outbound);
    yield* fixture.conn.originator.resolve(
      DispatchAuthorize.encodeResponse(id, {
        admission: { decision: "deny", reason: "policy/x" },
      }),
    );
    const verdict = yield* Fiber.join(fiber);
    yield* Scope.close(fixture.scope, Exit.void);
    expect(verdict).toEqual({ decision: "deny", reason: "policy/x" });
  });
}

function staleRemoteDispatchDenies() {
  return Effect.gen(function* () {
    const fixture = makeAppHostFixture();
    fixture.host.registerApp(
      baseManifest(APP_R),
      staleConnection(CONN_NO_SUCH),
    );
    const verdict = yield* startRemoteDispatch(
      fixture,
      APP_R,
      makeTaskId("00000000-0000-4000-8000-000000ce5573"),
    );
    expect(verdict).toEqual({
      decision: "deny",
      reason: "dispatch/authorize error",
    });
  });
}

function disconnectedRemoteDispatchDenies() {
  return Effect.gen(function* () {
    const fixture = yield* makeRemoteFixture(CONN_RD_DROP, baseManifest(APP_R));
    const fiber = yield* Effect.fork(
      startRemoteDispatch(
        fixture,
        APP_R,
        makeTaskId("00000000-0000-4000-8000-000000ce5570"),
      ),
    );
    yield* waitForLatestRequestId(fixture.outbound);
    yield* Scope.close(fixture.scope, Exit.void);
    const verdict = yield* Fiber.join(fiber);
    expect(verdict).toEqual({
      decision: "deny",
      reason: "dispatch/authorize error",
    });
  });
}

function malformedRemoteDispatchDenies() {
  return Effect.gen(function* () {
    const fixture = yield* makeRemoteFixture(
      CONN_RD_DECODE,
      baseManifest(APP_R),
    );
    const fiber = yield* Effect.fork(
      startRemoteDispatch(
        fixture,
        APP_R,
        makeTaskId("00000000-0000-4000-8000-000000ce55de"),
      ),
    );
    const id = yield* waitForLatestRequestId(fixture.outbound);
    yield* fixture.conn.originator.resolve(
      DispatchAuthorize.encodeResponse(id, { wrongShape: "nope" }),
    );
    const verdict = yield* Fiber.join(fiber);
    yield* Scope.close(fixture.scope, Exit.void);
    expect(verdict).toEqual({
      decision: "deny",
      reason: "dispatch/authorize error",
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Registration surface
// ─────────────────────────────────────────────────────────────────────

describe("AppHost.registerApp", () => {
  it("records the registration keyed by appId + bound conn", () => {
    const { host } = makeAppHostFixture();
    host.registerApp(baseManifest(APP_R), stubConnection(CONN_1));

    expect(host.lookupApp(APP_R)?.endpoint.connId).toBe(CONN_1);
  });

  it("rejects re-registration: registry is strict, no overwrites", () => {
    const { host } = makeAppHostFixture();
    const first = host.registerApp(baseManifest(APP_R), stubConnection(CONN_1));
    const second = host.registerApp(
      baseManifest(APP_R),
      stubConnection(CONN_2),
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    // The strict registry keeps the FIRST conn — the overwrite never lands.
    expect(host.lookupApp(APP_R)?.endpoint.connId).toBe(CONN_1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// messages/authorize — remote round-trip + fail-closed paths
// ─────────────────────────────────────────────────────────────────────

describe("AppHost remote messages — messages/authorize", () => {
  liveIt(
    "happy: remote replies with forward verdict; wire params omit signal",
    remoteMessageAuthorizeForwards,
  );

  liveIt(
    "missing-connection: stale registration fails closed to Block",
    staleRemoteMessageBlocks,
  );

  liveIt(
    "decode failure: malformed verdict from remote fails closed to Block",
    malformedRemoteMessageBlocks,
  );
});

describe("AppHost.unregisterApp", () => {
  it("drops the registration entirely (manifest + routing)", () => {
    const { host } = makeAppHostFixture();
    host.registerApp(baseManifest(APP_R), stubConnection(CONN_1));
    host.unregisterApp(APP_R);

    expect(host.lookupApp(APP_R)).toBeUndefined();
  });

  it("is idempotent for unknown appIds", () => {
    const { host } = makeAppHostFixture();
    expect(() => host.unregisterApp(APP_NEVER)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// dispatch/authorize — remote round-trip + fail-closed paths
// ─────────────────────────────────────────────────────────────────────

describe("AppHost remote dispatch — dispatch/authorize success", () => {
  liveIt(
    "happy: remote replies with grant verdict; envelope passes through",
    remoteDispatchGrantPassesThrough,
  );

  liveIt(
    "happy: remote deny verdict propagates verbatim",
    remoteDispatchDenyPassesThrough,
  );
});

describe("AppHost remote dispatch — dispatch/authorize fail closed", () => {
  liveIt(
    "missing-connection: stale registration fails closed to deny",
    staleRemoteDispatchDenies,
  );

  liveIt(
    "disconnect mid-flight: scope close fails closed to deny",
    disconnectedRemoteDispatchDenies,
  );

  liveIt(
    "decode failure: malformed verdict from remote fails closed to deny",
    malformedRemoteDispatchDenies,
  );
});
