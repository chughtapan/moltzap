/**
 * Gating tests for the AppHost remote-app routing surface (architect
 * plan §3.4). The dispatch helpers and registration paths exercised
 * here cover the single `dispatch/authorize` server→client round-trip.
 *
 * Tests run against `MoltZapConnection` directly (no testcontainers, no
 * real WS) so they stay pure-Effect — `TestClock`-drivable, no real
 * sleeps. The connection's `write` records outbound frames; the test
 * synthesizes inbound responses by calling `conn.jsonRpcClient.resolve`
 * (the same path the server's read fiber uses).
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Fiber, Ref, Scope } from "effect";
import type { Kysely } from "kysely";
import {
  DispatchAuthorize,
  type AppManifest,
  type JsonRpcId,
} from "@moltzap/protocol";
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
} from "../ws/connection.js";
import type { Database } from "../db/database.js";
import { makeFakeService } from "../test-utils/fakes.js";
import { AppHost } from "./app-host.js";
import type { TaskAuthorizeDispatchContext } from "./hooks.js";

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
 * `conn.jsonRpcClient.resolve`. The JsonRpcClient's Scope finalizer
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
    const jsonRpcClient = yield* acquireConnectionRpcClient(connId, write);
    const conn: MoltZapConnection = {
      id: connId,
      write,
      shutdown: noopShutdown,
      auth: null,
      lastPong: Date.now(),
      conversationIds: new Set<string>(),
      mutedConversations: new Set<string>(),
      jsonRpcClient,
    };
    return { conn, outbound };
  });

interface AppHostFixture {
  readonly host: AppHost;
  readonly connections: ConnectionManager;
}

function makeAppHostFixture(): AppHostFixture {
  const connections = new ConnectionManager();
  const db = makeFakeService<Kysely<Database>>({} as Partial<Kysely<Database>>);
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

const FIXTURE_CONVERSATION_ID = conversationId(
  "00000000-0000-4000-8000-000000000c01",
);
const FIXTURE_AGENT_RECIPIENT = agentId("00000000-0000-4000-8000-000000000a01");
const FIXTURE_AGENT_SENDER = agentId("00000000-0000-4000-8000-000000000a02");
const FIXTURE_MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000201");

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

/** Decode the most recently captured outbound frame from a fake connection. */
function captureLatestRequestId(
  outbound: Ref.Ref<ReadonlyArray<string>>,
): Effect.Effect<JsonRpcId, Error> {
  return Effect.gen(function* () {
    const xs = yield* Ref.get(outbound);
    if (xs.length === 0) {
      return yield* Effect.fail(new Error("no outbound frame yet"));
    }
    const parsed: unknown = JSON.parse(xs[xs.length - 1]!);
    if (!validateRequestFrame(parsed)) {
      return yield* Effect.fail(new Error("expected JSON-RPC request frame"));
    }
    return parsed.id;
  });
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
    const manifest = baseManifest("app-m", 1234);
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

describe("AppHost remote dispatch — dispatch/authorize", () => {
  it("happy: remote replies with grant verdict; envelope passes through", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = makeAppHostFixture();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-rd-1"),
        scope,
      );
      fixture.connections.add(conn);
      fixture.host.registerRemoteApp(baseManifest("app-r"), "conn-rd-1");

      const dispatch = dispatchAuthorizeDispatch(fixture.host);

      const fiber = yield* Effect.fork(
        dispatch(
          "app-r",
          baseAuthorizeDispatchCtx(
            "app-r",
            makeTaskId("00000000-0000-4000-8000-000000ce5510"),
          ),
        ),
      );
      const id = yield* captureLatestRequestId(outbound).pipe(
        Effect.retry({ times: 50, schedule: undefined }),
      );

      yield* conn.jsonRpcClient.resolve(
        DispatchAuthorize.encodeResponse(id, {
          admission: { decision: "grant", leaseId: "lease-1" },
        }),
      );

      const verdict = yield* Fiber.join(fiber);
      yield* Scope.close(scope, Exit.void);
      return verdict;
    });

    const result = await Effect.runPromise(program);
    expect(result).toEqual({ decision: "grant", leaseId: "lease-1" });
  });

  it("happy: remote deny verdict propagates verbatim", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = makeAppHostFixture();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-rd-deny"),
        scope,
      );
      fixture.connections.add(conn);
      fixture.host.registerRemoteApp(baseManifest("app-r"), "conn-rd-deny");

      const dispatch = dispatchAuthorizeDispatch(fixture.host);

      const fiber = yield* Effect.fork(
        dispatch(
          "app-r",
          baseAuthorizeDispatchCtx(
            "app-r",
            makeTaskId("00000000-0000-4000-8000-000000ce55d0"),
          ),
        ),
      );
      const id = yield* captureLatestRequestId(outbound).pipe(
        Effect.retry({ times: 50, schedule: undefined }),
      );
      yield* conn.jsonRpcClient.resolve(
        DispatchAuthorize.encodeResponse(id, {
          admission: { decision: "deny", reason: "policy/x" },
        }),
      );
      const verdict = yield* Fiber.join(fiber);
      yield* Scope.close(scope, Exit.void);
      return verdict;
    });
    const result = await Effect.runPromise(program);
    expect(result).toEqual({ decision: "deny", reason: "policy/x" });
  });

  it("missing-connection: stale registration → fail-closed deny", async () => {
    const program = Effect.gen(function* () {
      const fixture = makeAppHostFixture();
      // Register with a connection ID that was never `connections.add()`'d —
      // the dispatch helper resolves `connections.get(connId) === undefined`
      // and folds into the fail-closed branch.
      fixture.host.registerRemoteApp(baseManifest("app-r"), "no-such-conn");

      const dispatch = dispatchAuthorizeDispatch(fixture.host);

      return yield* dispatch(
        "app-r",
        baseAuthorizeDispatchCtx(
          "app-r",
          makeTaskId("00000000-0000-4000-8000-000000ce5573"),
        ),
      );
    });
    const result = await Effect.runPromise(program);
    expect(result).toEqual({
      decision: "deny",
      reason: "dispatch/authorize error",
    });
  });

  it("disconnect mid-flight: scope close → fail-closed deny", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = makeAppHostFixture();
      const { conn } = yield* Scope.extend(
        makeFakeConnection("conn-rd-drop"),
        scope,
      );
      fixture.connections.add(conn);
      fixture.host.registerRemoteApp(baseManifest("app-r"), "conn-rd-drop");

      const dispatch = dispatchAuthorizeDispatch(fixture.host);

      const fiber = yield* Effect.fork(
        dispatch(
          "app-r",
          baseAuthorizeDispatchCtx(
            "app-r",
            makeTaskId("00000000-0000-4000-8000-000000ce5570"),
          ),
        ),
      );
      // Tear down the connection scope before any response arrives.
      // The JsonRpcClient's Scope finalizer fails the pending Deferred
      // with `NotConnectedError`; the dispatch envelope catches it and
      // returns fail-closed deny.
      yield* Effect.yieldNow();
      yield* Scope.close(scope, Exit.void);
      const verdict = yield* Fiber.join(fiber);
      return verdict;
    });
    const result = await Effect.runPromise(program);
    expect(result).toEqual({
      decision: "deny",
      reason: "dispatch/authorize error",
    });
  });

  it("decode failure: malformed verdict from remote → fail-closed deny", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = makeAppHostFixture();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-rd-decode"),
        scope,
      );
      fixture.connections.add(conn);
      fixture.host.registerRemoteApp(baseManifest("app-r"), "conn-rd-decode");

      const dispatch = dispatchAuthorizeDispatch(fixture.host);

      const fiber = yield* Effect.fork(
        dispatch(
          "app-r",
          baseAuthorizeDispatchCtx(
            "app-r",
            makeTaskId("00000000-0000-4000-8000-000000ce55de"),
          ),
        ),
      );
      const id = yield* captureLatestRequestId(outbound).pipe(
        Effect.retry({ times: 50, schedule: undefined }),
      );
      // Reply with a payload that does not match the envelope schema.
      yield* conn.jsonRpcClient.resolve(
        DispatchAuthorize.encodeResponse(id, { wrongShape: "nope" }),
      );
      const verdict = yield* Fiber.join(fiber);
      yield* Scope.close(scope, Exit.void);
      return verdict;
    });
    const result = await Effect.runPromise(program);
    expect(result).toEqual({
      decision: "deny",
      reason: "dispatch/authorize error",
    });
  });
});
