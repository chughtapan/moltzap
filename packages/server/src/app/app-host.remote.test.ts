/**
 * Gating tests for the AppHost remote-app routing surface (architect
 * plan §3.4). The dispatch helpers and registration paths exercised
 * here cover the single `dispatch/authorize` server→client round-trip.
 *
 * Tests run against `MoltZapConnection` directly (no testcontainers, no
 * real WS) so they stay pure-Effect — `TestClock`-drivable, no real
 * sleeps. The connection's `write` records outbound frames; the test
 * synthesizes inbound responses by calling `conn.originator.resolve`
 * (the same path the server's read fiber uses).
 */
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vitest";
import { Data, Effect, Exit, Fiber, Ref, Scope } from "effect";
import {
  DispatchAuthorize,
  MessagesAuthorize,
  type AppManifest,
  type JsonRpcId,
} from "@moltzap/protocol";
import { endpointAddress } from "@moltzap/protocol/network";
import {
  agentId,
  conversationId,
  messageId,
  taskId as makeTaskId,
  validateRequestFrame,
} from "@moltzap/protocol/testing";
import {
  acquireConnectionRpcClient,
  ConnectionManager,
  type MoltZapConnection,
} from "../transport/connection.js";
import type { Db } from "../db/client.js";
import { makeFakeService } from "../test-utils/fakes.js";
import { AppHost } from "./app-host.js";
import type {
  MessageAuthorizeContext,
  TaskAuthorizeDispatchContext,
} from "./hooks.js";

const liveIt = effectIt.live;

// ─────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────

const noopShutdown: MoltZapConnection["shutdown"] = Effect.void;

interface FakeConn {
  readonly conn: MoltZapConnection;
  readonly outbound: Ref.Ref<ReadonlyArray<string>>;
}

/**
 * Build a real {@link MoltZapConnection} whose `write` records outbound
 * frames into a Ref. Caller can `JSON.parse` the captured frame to get
 * the request id, then synthesize a matching response via
 * `conn.originator.resolve`. The JsonRpcClient's Scope finalizer
 * fails every still-pending call with `NotConnectedError` when the
 * surrounding scope closes — close to drive the disconnect path.
 */
const makeFakeConnection = (
  connId: string,
): Effect.Effect<FakeConn, never, Scope.Scope> =>
  Effect.gen(function* () {
    const outbound = yield* Ref.make<ReadonlyArray<string>>([]);
    const write: MoltZapConnection["write"] = (raw) =>
      Ref.update(outbound, (xs) => [...xs, raw]);
    const originator = yield* acquireConnectionRpcClient(connId, write);
    const conn: MoltZapConnection = {
      id: connId,
      write,
      shutdown: noopShutdown,
      auth: null,
      lastPong: Date.now(),
      conversationIds: new Set<string>(),
      mutedConversations: new Set<string>(),
      originator,
    };
    return { conn, outbound };
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

const baseManifest = (appId: string, hookTimeoutMs?: number): AppManifest => ({
  appId,
  name: `Test App ${appId}`,
  conversations: [],
  hooks: hookTimeoutMs
    ? { dispatch_authorize: { timeout_ms: hookTimeoutMs } }
    : undefined,
});

const messageAuthorizeManifest = (
  appId: string,
  hookTimeoutMs?: number,
): AppManifest => ({
  appId,
  name: `Test App ${appId}`,
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
const MESSAGE_APP_ID = "00000000-0000-4000-8000-000000000560";
const MANIFEST_DISPATCH_TIMEOUT_MS = 1234;
const MESSAGE_TM_ADDRESS = endpointAddress(`tm:app:${MESSAGE_APP_ID}`);

const baseAuthorizeDispatchCtx = (
  appId: string,
  taskId: ReturnType<typeof makeTaskId>,
): TaskAuthorizeDispatchContext => ({
  conversationId: FIXTURE_CONVERSATION_ID,
  recipient: { agentId: FIXTURE_AGENT_RECIPIENT, ownerId: "owner-r" },
  message: { id: FIXTURE_MESSAGE_ID, senderAgentId: FIXTURE_AGENT_SENDER },
  taskId,
  appId,
  attempt: 0,
  signal: new AbortController().signal,
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
  signal: new AbortController().signal,
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

function privateField<T>(target: object, key: string): T {
  return Reflect.get(target, key) as T;
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

type RemoteRegistrations = Map<string, { connectionId: string }>;
type AuthorizeDispatchDispatch = (
  appId: string,
  ctx: TaskAuthorizeDispatchContext,
) => Effect.Effect<unknown, never>;

const remoteRegistrations = (host: AppHost): RemoteRegistrations =>
  privateField<RemoteRegistrations>(host, "remoteRegistrations");

const dispatchAuthorizeDispatch = (host: AppHost): AuthorizeDispatchDispatch =>
  bindPrivateMethod(host, "dispatchAuthorizeHook");

function makeRemoteFixture(connectionId: string, manifest: AppManifest) {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const fixture = makeAppHostFixture();
    const { conn, outbound } = yield* Scope.extend(
      makeFakeConnection(connectionId),
      scope,
    );
    fixture.connections.add(conn);
    fixture.host.registerRemoteApp(manifest, connectionId);
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
      "conn-rm-1",
      messageAuthorizeManifest(MESSAGE_APP_ID),
    );
    const taskId = makeTaskId("00000000-0000-4000-8000-000000ce5601");
    const fiber = yield* Effect.fork(
      fixture.host.runMessageAuthorize(
        MESSAGE_TM_ADDRESS,
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
    fixture.host.registerRemoteApp(
      messageAuthorizeManifest(MESSAGE_APP_ID),
      "no-such-conn",
    );
    const result = yield* fixture.host.runMessageAuthorize(
      MESSAGE_TM_ADDRESS,
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
      "conn-rm-decode",
      messageAuthorizeManifest(MESSAGE_APP_ID),
    );
    const fiber = yield* Effect.fork(
      fixture.host.runMessageAuthorize(
        MESSAGE_TM_ADDRESS,
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
    const fixture = yield* makeRemoteFixture(
      "conn-rd-1",
      baseManifest("app-r"),
    );
    const fiber = yield* Effect.fork(
      startRemoteDispatch(
        fixture,
        "app-r",
        makeTaskId("00000000-0000-4000-8000-000000ce5510"),
      ),
    );
    const id = yield* waitForLatestRequestId(fixture.outbound);
    yield* fixture.conn.originator.resolve(
      DispatchAuthorize.encodeResponse(id, {
        admission: { decision: "grant", leaseId: "lease-1" },
      }),
    );
    const verdict = yield* Fiber.join(fiber);
    yield* Scope.close(fixture.scope, Exit.void);
    expect(verdict).toEqual({ decision: "grant", leaseId: "lease-1" });
  });
}

function remoteDispatchDenyPassesThrough() {
  return Effect.gen(function* () {
    const fixture = yield* makeRemoteFixture(
      "conn-rd-deny",
      baseManifest("app-r"),
    );
    const fiber = yield* Effect.fork(
      startRemoteDispatch(
        fixture,
        "app-r",
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
    fixture.host.registerRemoteApp(baseManifest("app-r"), "no-such-conn");
    const verdict = yield* startRemoteDispatch(
      fixture,
      "app-r",
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
    const fixture = yield* makeRemoteFixture(
      "conn-rd-drop",
      baseManifest("app-r"),
    );
    const fiber = yield* Effect.fork(
      startRemoteDispatch(
        fixture,
        "app-r",
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
      "conn-rd-decode",
      baseManifest("app-r"),
    );
    const fiber = yield* Effect.fork(
      startRemoteDispatch(
        fixture,
        "app-r",
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

describe("AppHost.registerRemoteApp", () => {
  it("records the remote-app source keyed by appId", () => {
    const { host } = makeAppHostFixture();
    host.registerRemoteApp(baseManifest("app-r"), "conn-1");

    const map = remoteRegistrations(host);
    expect(map.get("app-r")).toEqual({ connectionId: "conn-1" });
  });

  it("stores the manifest verbatim (so dispatch can read timeout_ms)", () => {
    const { host } = makeAppHostFixture();
    const manifest = baseManifest("app-m", MANIFEST_DISPATCH_TIMEOUT_MS);
    host.registerRemoteApp(manifest, "conn-1");
    expect(host.getManifest("app-m")).toBe(manifest);
  });

  it("re-registration overwrites the prior connection", () => {
    const { host } = makeAppHostFixture();
    host.registerRemoteApp(baseManifest("app-r"), "conn-1");
    host.registerRemoteApp(baseManifest("app-r"), "conn-2");

    const map = remoteRegistrations(host);
    expect(map.get("app-r")).toEqual({ connectionId: "conn-2" });
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

describe("AppHost.unregisterRemoteApp", () => {
  it("drops the routing entry; manifest stays", () => {
    const { host } = makeAppHostFixture();
    const manifest = baseManifest("app-r");
    host.registerRemoteApp(manifest, "conn-1");
    host.unregisterRemoteApp("app-r");

    const map = remoteRegistrations(host);
    expect(map.has("app-r")).toBe(false);
    expect(host.getManifest("app-r")).toBe(manifest);
  });

  it("is idempotent for unknown appIds", () => {
    const { host } = makeAppHostFixture();
    expect(() => host.unregisterRemoteApp("never-registered")).not.toThrow();
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
