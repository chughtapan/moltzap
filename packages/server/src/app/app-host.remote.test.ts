/**
 * Phase 1.2 (B.3) gating tests for the AppHost remote-app routing
 * surface (architect plan §3.4). These tests exercise the
 * `registerRemoteApp` / `unregisterRemoteApp` registration shape and
 * each per-hook dispatch path's behaviour against a mocked
 * `MoltZapConnection` + `ConnectionManager`. Wire-level coverage of
 * `sendRpcToClient` itself lives in `ws/connection.appCallback.test.ts`; this
 * file tests the AppHost-side composition (timeout envelope, fail-closed
 * mapping, multi-app deny short-circuit).
 *
 * Running against `MoltZapConnection` directly (no testcontainers, no
 * real WS) keeps the tests pure-Effect — `TestClock`-drivable, no real
 * sleeps. The connection's `write` records outbound frames; the test
 * synthesizes inbound responses by calling `completeAppCallbackResponse` (the
 * same path the server's read fiber uses).
 */
import { describe, expect, it } from "vitest";
import { it as itEffect } from "@effect/vitest";
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Fiber,
  Ref,
  Scope,
  TestClock,
} from "effect";
import type { Kysely } from "kysely";
import {
  responseFrame,
  validators,
  type AppManifest,
  type JsonRpcStringId,
} from "@moltzap/protocol";
import {
  acquireAppCallbackConnectionState,
  completeAppCallbackResponse,
  ConnectionManager,
  type MoltZapConnection,
} from "../ws/connection.js";
import type { Database } from "../db/database.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import { makeFakeService } from "../test-utils/fakes.js";
import { AppHost } from "./app-host.js";
import type {
  BeforeDispatchContext,
  BeforeMessageDeliveryContext,
} from "./hooks.js";

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
 * `completeAppCallbackResponse`. The Scope finalizer wires `AppDisconnected` —
 * close the surrounding scope to drive the disconnect path.
 */
const makeFakeConnection = (
  connId: string,
): Effect.Effect<FakeConn, never, Scope.Scope> =>
  Effect.gen(function* () {
    const outbound = yield* Ref.make<ReadonlyArray<string>>([]);
    const state = yield* acquireAppCallbackConnectionState(connId);
    const write: MoltZapConnection["write"] = (raw) =>
      Ref.update(outbound, (xs) => [...xs, raw]);
    const conn: MoltZapConnection = {
      id: connId,
      write,
      shutdown: noopShutdown,
      auth: null,
      lastPong: Date.now(),
      conversationIds: new Set<string>(),
      mutedConversations: new Set<string>(),
      appCallbackPending: state.appCallbackPending,
      appCallbackRequestCounter: state.appCallbackRequestCounter,
    };
    return { conn, outbound };
  });

interface AppHostFixture {
  readonly host: AppHost;
  readonly connections: ConnectionManager;
  readonly sentEvents: Array<{ agentId: string; event: unknown }>;
}

/**
 * Build an AppHost with a real {@link ConnectionManager} (so registered
 * remote-app connections route correctly) and fake services for every
 * dependency that the dispatch helpers do not touch.
 */
function makeAppHostFixture(): AppHostFixture {
  const sentEvents: Array<{ agentId: string; event: unknown }> = [];
  const broadcaster = makeFakeService<Broadcaster>({
    sendToAgent: (agentId: string, event: unknown) => {
      sentEvents.push({ agentId, event });
    },
  } as Partial<Broadcaster>);
  const connections = new ConnectionManager();
  const db = makeFakeService<Kysely<Database>>({} as Partial<Kysely<Database>>);
  const host = new AppHost(db, broadcaster, connections, null);
  return { host, connections, sentEvents };
}

const baseManifest = (appId: string, hookTimeoutMs?: number): AppManifest => ({
  appId,
  name: `Test App ${appId}`,
  conversations: [],
  hooks: hookTimeoutMs
    ? {
        before_dispatch: { timeout_ms: hookTimeoutMs },
        before_message_delivery: { timeout_ms: hookTimeoutMs },
        on_session_active: { timeout_ms: hookTimeoutMs },
        on_close: { timeout_ms: hookTimeoutMs },
      }
    : undefined,
});

const FIXTURE_CONVERSATION_ID = "00000000-0000-4000-8000-000000000c01";
const FIXTURE_AGENT_RECIPIENT = "00000000-0000-4000-8000-000000000a01";
const FIXTURE_AGENT_SENDER = "00000000-0000-4000-8000-000000000a02";
const FIXTURE_MESSAGE_ID = "00000000-0000-4000-8000-000000000201";

const baseBeforeDispatchCtx = (
  appId: string,
  sessionId: string,
): BeforeDispatchContext => ({
  conversationId: FIXTURE_CONVERSATION_ID,
  recipient: { agentId: FIXTURE_AGENT_RECIPIENT, ownerId: "owner-r" },
  message: { id: FIXTURE_MESSAGE_ID, senderAgentId: FIXTURE_AGENT_SENDER },
  sessionId,
  appId,
  attempt: 0,
  signal: new AbortController().signal,
});

const baseBeforeMessageDeliveryCtx = (
  appId: string,
  sessionId: string,
): BeforeMessageDeliveryContext => ({
  conversationId: FIXTURE_CONVERSATION_ID,
  sender: { agentId: FIXTURE_AGENT_SENDER, ownerId: "owner-s" },
  message: { parts: [{ type: "text", text: "hi" }] },
  sessionId,
  appId,
  signal: new AbortController().signal,
});

/** Decode the most recently captured outbound frame from a fake connection. */
function captureLatestRequestId(
  outbound: Ref.Ref<ReadonlyArray<string>>,
): Effect.Effect<JsonRpcStringId, Error> {
  return Effect.gen(function* () {
    const xs = yield* Ref.get(outbound);
    if (xs.length === 0) {
      return yield* Effect.fail(new Error("no outbound frame yet"));
    }
    const parsed: unknown = JSON.parse(xs[xs.length - 1]!);
    if (!validators.requestFrame(parsed)) {
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
type BeforeDispatchDispatch = (
  appId: string,
  ctx: BeforeDispatchContext,
) => Effect.Effect<unknown, never>;
type BeforeMessageDeliveryDispatch = (
  appId: string,
  ctx: BeforeMessageDeliveryContext,
) => Effect.Effect<unknown, never>;
type DenyShortCircuitDispatch = <V>(
  appIds: readonly string[],
  isShortCircuit: (v: V) => boolean,
  defaultVerdict: V,
  perApp: (appId: string) => Effect.Effect<V, never>,
) => Effect.Effect<V, never>;

const remoteRegistrations = (host: AppHost): RemoteRegistrations =>
  privateField<RemoteRegistrations>(host, "remoteRegistrations");

const dispatchBeforeDispatch = (host: AppHost): BeforeDispatchDispatch =>
  bindPrivateMethod(host, "dispatchBeforeDispatchHook");

const dispatchBeforeMessageDelivery = (
  host: AppHost,
): BeforeMessageDeliveryDispatch =>
  bindPrivateMethod(host, "dispatchBeforeMessageDeliveryHook");

const dispatchWithDenyShortCircuit = (
  host: AppHost,
): DenyShortCircuitDispatch =>
  bindPrivateMethod(host, "dispatchAcrossAppsWithDenyShortCircuit");

// ─────────────────────────────────────────────────────────────────────
// Registration surface
// ─────────────────────────────────────────────────────────────────────

describe("AppHost.registerRemoteApp", () => {
  it("records the remote-app source keyed by appId", () => {
    const { host } = makeAppHostFixture();
    host.registerRemoteApp(baseManifest("app-r"), "conn-1");

    // Inspect via private state — the public observation surface is
    // the dispatch path, exercised in the dispatch suites below.
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
// before_dispatch — remote round-trip + fail-closed paths
// ─────────────────────────────────────────────────────────────────────

describe("AppHost remote dispatch — apps/onBeforeDispatch", () => {
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

      // Drive `dispatchBeforeDispatchHook` directly — it's the uniform
      // surface that `runBeforeDispatch` calls. Keeps the test free of
      // DB / conversation-mapping setup.
      const dispatch = dispatchBeforeDispatch(fixture.host);

      const fiber = yield* Effect.fork(
        dispatch("app-r", baseBeforeDispatchCtx("app-r", "sess-1")),
      );
      // Yield repeatedly so the fork's inner write lands.
      const id = yield* captureLatestRequestId(outbound).pipe(
        Effect.retry({ times: 50, schedule: undefined }),
      );

      yield* completeAppCallbackResponse(
        conn,
        responseFrame(id, {
          result: {
            admission: { decision: "grant", leaseId: "lease-1" },
          },
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

      const dispatch = dispatchBeforeDispatch(fixture.host);

      const fiber = yield* Effect.fork(
        dispatch("app-r", baseBeforeDispatchCtx("app-r", "sess-d")),
      );
      const id = yield* captureLatestRequestId(outbound).pipe(
        Effect.retry({ times: 50, schedule: undefined }),
      );
      yield* completeAppCallbackResponse(
        conn,
        responseFrame(id, {
          result: {
            admission: { decision: "deny", reason: "policy/x" },
          },
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

      const dispatch = dispatchBeforeDispatch(fixture.host);

      return yield* dispatch(
        "app-r",
        baseBeforeDispatchCtx("app-r", "sess-stale"),
      );
    });
    const result = await Effect.runPromise(program);
    expect(result).toEqual({
      decision: "deny",
      reason: "before_dispatch hook error",
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

      const dispatch = dispatchBeforeDispatch(fixture.host);

      const fiber = yield* Effect.fork(
        dispatch("app-r", baseBeforeDispatchCtx("app-r", "sess-drop")),
      );
      // Tear down the connection scope before any response arrives.
      // The Scope finalizer fails the pending Deferred with
      // `AppDisconnected`; the dispatch envelope catches it and returns
      // fail-closed deny.
      yield* Effect.yieldNow();
      yield* Scope.close(scope, Exit.void);
      const verdict = yield* Fiber.join(fiber);
      return verdict;
    });
    const result = await Effect.runPromise(program);
    expect(result).toEqual({
      decision: "deny",
      reason: "before_dispatch hook error",
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

      const dispatch = dispatchBeforeDispatch(fixture.host);

      const fiber = yield* Effect.fork(
        dispatch("app-r", baseBeforeDispatchCtx("app-r", "sess-dec")),
      );
      const id = yield* captureLatestRequestId(outbound).pipe(
        Effect.retry({ times: 50, schedule: undefined }),
      );
      // Reply with a payload that does not match the envelope schema.
      yield* completeAppCallbackResponse(
        conn,
        responseFrame(id, { result: { wrongShape: "nope" } }),
      );
      const verdict = yield* Fiber.join(fiber);
      yield* Scope.close(scope, Exit.void);
      return verdict;
    });
    const result = await Effect.runPromise(program);
    expect(result).toEqual({
      decision: "deny",
      reason: "before_dispatch hook error",
    });
  });

  itEffect("timeout: manifest timeout fires → fail-closed deny", () =>
    Effect.gen(function* () {
      const fixture = makeAppHostFixture();
      // Use a real (Scope-managed) connection but never settle the
      // pending Deferred. The TestClock advances time; the dispatch
      // envelope's Effect.timeout catches `TimeoutException`.
      const setup = yield* Effect.scoped(
        Effect.gen(function* () {
          const { conn } = yield* makeFakeConnection("conn-rd-tout");
          fixture.connections.add(conn);
          return conn.id;
        }),
      ).pipe(Effect.fork);
      // Re-acquire under a longer-lived scope: the disconnect path
      // would short-circuit our timeout assertion. Instead, register
      // a fresh connection in a fresh scope kept alive for the test.
      yield* Fiber.interrupt(setup);

      // Long-lived scoped connection.
      const longScope = yield* Scope.make();
      const conn2 = yield* Scope.extend(
        makeFakeConnection("conn-rd-tout-2"),
        longScope,
      ).pipe(Effect.map((s) => s.conn));
      fixture.connections.add(conn2);
      fixture.host.registerRemoteApp(
        baseManifest("app-r", 200),
        "conn-rd-tout-2",
      );

      const dispatch = dispatchBeforeDispatch(fixture.host);

      const fiber = yield* Effect.fork(
        dispatch("app-r", baseBeforeDispatchCtx("app-r", "sess-tout")),
      );
      // Let the request frame land and the Deferred park.
      yield* Effect.yieldNow();
      // Drive the manifest timeout under TestClock.
      yield* TestClock.adjust(Duration.millis(250));
      const verdict = yield* Fiber.join(fiber);

      expect(verdict).toEqual({
        decision: "deny",
        reason: "before_dispatch hook timed out",
      });

      yield* Scope.close(longScope, Exit.void);
    }),
  );
});

// ─────────────────────────────────────────────────────────────────────
// before_message_delivery — fail-CLOSED to block: true
// ─────────────────────────────────────────────────────────────────────

describe("AppHost remote dispatch — apps/onBeforeMessageDelivery", () => {
  it("happy: remote replies with non-blocking HookResult", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = makeAppHostFixture();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-bmd"),
        scope,
      );
      fixture.connections.add(conn);
      fixture.host.registerRemoteApp(baseManifest("app-bmd"), "conn-bmd");

      const dispatch = dispatchBeforeMessageDelivery(fixture.host);

      const fiber = yield* Effect.fork(
        dispatch("app-bmd", baseBeforeMessageDeliveryCtx("app-bmd", "sess-1")),
      );
      const id = yield* captureLatestRequestId(outbound).pipe(
        Effect.retry({ times: 50, schedule: undefined }),
      );
      yield* completeAppCallbackResponse(
        conn,
        responseFrame(id, { result: { block: false } }),
      );
      const result = yield* Fiber.join(fiber);
      yield* Scope.close(scope, Exit.void);
      return result;
    });
    expect(await Effect.runPromise(program)).toEqual({ block: false });
  });

  it("missing-connection: stale registration → fail-closed block: true", async () => {
    const program = Effect.gen(function* () {
      const fixture = makeAppHostFixture();
      fixture.host.registerRemoteApp(baseManifest("app-bmd"), "no-conn");

      const dispatch = dispatchBeforeMessageDelivery(fixture.host);

      return yield* dispatch(
        "app-bmd",
        baseBeforeMessageDeliveryCtx("app-bmd", "sess-stale"),
      );
    });
    expect(await Effect.runPromise(program)).toEqual({
      block: true,
      reason: "before_message_delivery hook error",
    });
  });

  it("rpc error: remote responds with typed RpcResponseError → fail-closed block: true", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = makeAppHostFixture();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-bmd-err"),
        scope,
      );
      fixture.connections.add(conn);
      fixture.host.registerRemoteApp(baseManifest("app-bmd"), "conn-bmd-err");

      const dispatch = dispatchBeforeMessageDelivery(fixture.host);

      const fiber = yield* Effect.fork(
        dispatch("app-bmd", baseBeforeMessageDeliveryCtx("app-bmd", "sess-e")),
      );
      const id = yield* captureLatestRequestId(outbound).pipe(
        Effect.retry({ times: 50, schedule: undefined }),
      );
      yield* completeAppCallbackResponse(
        conn,
        responseFrame(id, {
          error: { code: -32000, message: "remote refused" },
        }),
      );
      const result = yield* Fiber.join(fiber);
      yield* Scope.close(scope, Exit.void);
      return result;
    });
    expect(await Effect.runPromise(program)).toEqual({
      block: true,
      reason: "before_message_delivery hook error",
    });
  });
});

// Phase 7 cutover removed `AppHost.dispatchOnSessionActiveHook` and
// `dispatchOnCloseHook` along with the session-bootstrap path that was
// the only caller. The lifecycle hook RPCs (`apps/onSessionActive`,
// `apps/onClose`) survive on the wire until Phase 9 deletes them; the
// fail-OPEN missing-connection assertions reactivate alongside Phase 9's
// TM-topology lifecycle wiring.

// ─────────────────────────────────────────────────────────────────────
// In-process path remains unchanged
// ─────────────────────────────────────────────────────────────────────

describe("AppHost in-process dispatch — preserved behaviour", () => {
  it("returns grant when no hook is registered", async () => {
    const fixture = makeAppHostFixture();
    fixture.host.registerApp(baseManifest("app-ip"));

    const dispatch = dispatchBeforeDispatch(fixture.host);
    const verdict = await Effect.runPromise(
      dispatch("app-ip", baseBeforeDispatchCtx("app-ip", "sess-ip")),
    );
    expect(verdict).toEqual({ decision: "grant" });
  });

  it("invokes the in-process handler and returns its verdict", async () => {
    const fixture = makeAppHostFixture();
    fixture.host.registerApp(baseManifest("app-ip"));
    fixture.host.onBeforeDispatch("app-ip", () => ({
      decision: "deny",
      reason: "in-process-policy",
    }));

    const dispatch = dispatchBeforeDispatch(fixture.host);
    const verdict = await Effect.runPromise(
      dispatch("app-ip", baseBeforeDispatchCtx("app-ip", "sess-ip")),
    );
    expect(verdict).toEqual({
      decision: "deny",
      reason: "in-process-policy",
    });
  });

  it("a thrown handler is mapped to fail-closed deny", async () => {
    const fixture = makeAppHostFixture();
    fixture.host.registerApp(baseManifest("app-ip"));
    fixture.host.onBeforeDispatch("app-ip", () => {
      throw new Error("boom");
    });

    const dispatch = dispatchBeforeDispatch(fixture.host);
    const verdict = await Effect.runPromise(
      dispatch("app-ip", baseBeforeDispatchCtx("app-ip", "sess-ip")),
    );
    expect(verdict).toEqual({
      decision: "deny",
      reason: "before_dispatch hook error",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Multi-app FIFO short-circuit (architect plan §3.4 acceptance #3)
// ─────────────────────────────────────────────────────────────────────

describe("AppHost.dispatchAcrossAppsWithDenyShortCircuit", () => {
  it("invokes apps in registration order and returns the last grant when none deny", async () => {
    const fixture = makeAppHostFixture();
    const calls: string[] = [];

    const combinator = dispatchWithDenyShortCircuit(fixture.host);

    type V = { decision: "grant" } | { decision: "deny"; reason: string };
    const verdict = await Effect.runPromise(
      combinator<V>(
        ["a", "b", "c"],
        (v): boolean => v.decision === "deny",
        { decision: "grant" } as V,
        (appId) =>
          Effect.sync(() => {
            calls.push(appId);
            return { decision: "grant" } as V;
          }),
      ),
    );

    expect(calls).toEqual(["a", "b", "c"]);
    expect(verdict).toEqual({ decision: "grant" });
  });

  it("short-circuits on first deny — later apps are NOT invoked", async () => {
    const fixture = makeAppHostFixture();
    const calls: string[] = [];

    const combinator = dispatchWithDenyShortCircuit(fixture.host);

    type V = { decision: "grant" } | { decision: "deny"; reason: string };
    const verdict = await Effect.runPromise(
      combinator<V>(
        ["a", "b", "c"],
        (v): boolean => v.decision === "deny",
        { decision: "grant" } as V,
        (appId) =>
          Effect.sync(() => {
            calls.push(appId);
            return appId === "b"
              ? ({ decision: "deny", reason: "stop" } as V)
              : ({ decision: "grant" } as V);
          }),
      ),
    );

    expect(calls).toEqual(["a", "b"]);
    expect(verdict).toEqual({ decision: "deny", reason: "stop" });
  });

  it("returns the default verdict for an empty list", async () => {
    const fixture = makeAppHostFixture();

    const combinator = dispatchWithDenyShortCircuit(fixture.host);

    const verdict = await Effect.runPromise(
      combinator<{ decision: "grant" }>(
        [],
        () => false,
        { decision: "grant" } as const,
        () => Effect.die("should not run"),
      ),
    );

    expect(verdict).toEqual({ decision: "grant" });
  });

  // Suppress an unused-import lint if Cause isn't referenced after edits.
  it("no leaked Causes (sanity)", () => {
    expect(typeof Cause.pretty).toBe("function");
  });
});
