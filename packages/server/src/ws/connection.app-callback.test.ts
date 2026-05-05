/**
 * Phase 1.0 (B.1) gating tests for the server-initiated awaitable RPC
 * primitives. Three scenarios — happy-path round-trip, disconnect mid-
 * request, caller timeout — exercise the contract that AppHost (B.3)
 * relies on. Comprehensive conformance lands in B.8; these are the
 * minimum tests that gate this PR.
 *
 * The tests run against `MoltZapConnection` directly: no testcontainers,
 * no real WebSocket. The connection's `write` is a mock that records
 * outbound frames, and inbound responses are injected by calling
 * `completeAppCallbackResponse` directly. This keeps the round-trip a pure-Effect
 * test of the protocol primitive — wire integration is covered by B.9.
 */
import { describe, expect, it } from "vitest";
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Fiber,
  HashMap,
  Ref,
  Scope,
} from "effect";
import * as Socket from "@effect/platform/Socket";
import {
  AppDisconnected,
  AppCallbackRpcResponseError,
  acquireAppCallbackConnectionState,
  completeAppCallbackResponse,
  sendRpcToClient,
  type MoltZapConnection,
} from "./connection.js";

import {
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnClose,
  AppsOnSessionActive,
  agentId,
  conversationId,
  messageId,
  responseFrame,
  taskId as makeTaskId,
  validators,
  type RequestFrame,
} from "@moltzap/protocol";

const noopShutdown: MoltZapConnection["shutdown"] = Effect.void;
const TASK_ID = makeTaskId("11111111-1111-4111-8111-111111111111");
const APP_ID = "test-app";
const AGENT_ID = agentId("22222222-2222-4222-8222-222222222222");
const CONVERSATION_ID = conversationId("33333333-3333-4333-8333-333333333333");
const MESSAGE_ID = messageId("44444444-4444-4444-8444-444444444444");
const PARTICIPANT = { agentId: AGENT_ID, ownerId: "owner-a" } as const;

const onCloseParams = (taskId = TASK_ID) => ({
  taskId,
  appId: APP_ID,
  conversations: { main: CONVERSATION_ID },
  closedBy: PARTICIPANT,
});

const onSessionActiveParams = (taskId = TASK_ID) => ({
  taskId,
  appId: APP_ID,
  conversations: { main: CONVERSATION_ID },
  admittedAgentIds: [AGENT_ID],
});

const beforeDispatchParams = (text: string) => ({
  taskId: TASK_ID,
  appId: APP_ID,
  conversationId: CONVERSATION_ID,
  recipient: PARTICIPANT,
  message: {
    id: MESSAGE_ID,
    senderAgentId: AGENT_ID,
    parts: [{ type: "text" as const, text }],
  },
  attempt: 0,
});

const beforeMessageDeliveryParams = (text: string) => ({
  taskId: TASK_ID,
  appId: APP_ID,
  conversationId: CONVERSATION_ID,
  sender: PARTICIPANT,
  message: { parts: [{ type: "text" as const, text }] },
});

interface FakeConnSetup {
  readonly conn: MoltZapConnection;
  readonly outbound: Ref.Ref<ReadonlyArray<string>>;
}

/**
 * Build a `MoltZapConnection` whose `write` records outbound frames into
 * a Ref. Caller can inspect the captured frame, then synthesize the
 * matching inbound response via `completeAppCallbackResponse`.
 *
 * `acquireAppCallbackConnectionState` registers the disconnect-finalizer on the
 * surrounding scope; tests close the scope to drive the failure path.
 */
const makeFakeConnection = (
  connId: string,
): Effect.Effect<FakeConnSetup, never, Scope.Scope> =>
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

function parseRequestFrame(raw: string): RequestFrame {
  const parsed: unknown = JSON.parse(raw);
  if (!validators.requestFrame(parsed)) {
    throw new Error("expected JSON-RPC request frame");
  }
  return parsed;
}

describe("sendRpcToClient — happy-path round-trip", () => {
  it("encodes an appCallback request, awaits the matching response, and returns the result", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-happy"),
        scope,
      );

      // Fork the request — `sendRpcToClient` parks on a Deferred until
      // `completeAppCallbackResponse` settles it. Forking lets the test thread
      // synthesize the matching response.
      const fiber = yield* Effect.fork(
        sendRpcToClient(
          conn,
          AppsOnSessionActive,
          onSessionActiveParams(
            makeTaskId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          ),
        ),
      );

      // Wait for the outbound frame to land in the Ref. `Effect.repeat`
      // with a tiny delay polls until the request frame appears — no
      // hand-rolled setTimeout retry loop.
      const captured = yield* Ref.get(outbound).pipe(
        Effect.flatMap((xs) =>
          xs.length > 0
            ? Effect.succeed(xs[0]!)
            : Effect.fail(new Error("no frame yet")),
        ),
        Effect.retry({ times: 50, schedule: undefined }),
      );

      const frame = parseRequestFrame(captured);
      expect(frame.method).toBe(AppsOnSessionActive.name);
      expect(frame.params).toEqual(
        onSessionActiveParams(
          makeTaskId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        ),
      );
      // `srv-<connId>-<seq>` namespace prefix keeps server-minted ids
      // disjoint from client-minted request ids.
      expect(frame.id.startsWith("srv-conn-happy-")).toBe(true);

      // Synthesize the matching response and route it through the
      // server's inbound completion path. This is exactly what the real
      // server's `handleFrame` does when a response frame arrives.
      const completed = yield* completeAppCallbackResponse(
        conn,
        responseFrame(frame.id, {
          result: {},
        }),
      );
      expect(completed._tag).toBe("Some");

      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);
      yield* Scope.close(scope, Exit.void);

      return exit;
    });

    const exit = await Effect.runPromise(program);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({});
    }
  });

  it("propagates a typed error response as AppCallbackRpcResponseError", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-err"),
        scope,
      );

      const fiber = yield* Effect.fork(
        sendRpcToClient(
          conn,
          AppsOnClose,
          onCloseParams(makeTaskId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")),
        ),
      );

      const captured = yield* Ref.get(outbound).pipe(
        Effect.flatMap((xs) =>
          xs.length > 0
            ? Effect.succeed(xs[0]!)
            : Effect.fail(new Error("no frame yet")),
        ),
        Effect.retry({ times: 50, schedule: undefined }),
      );
      const { id } = parseRequestFrame(captured);

      yield* completeAppCallbackResponse(
        conn,
        responseFrame(id, {
          error: { code: -32000, message: "session-already-closed" },
        }),
      );

      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);
      yield* Scope.close(scope, Exit.void);
      return exit;
    });

    const exit = await Effect.runPromise(program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(AppCallbackRpcResponseError);
        const e = err.value as AppCallbackRpcResponseError;
        expect(e.code).toBe(-32000);
        expect(e.message).toBe("session-already-closed");
        expect(e.method).toBe(AppsOnClose.name);
      }
    }
  });
});

describe("sendRpcToClient — disconnect mid-request", () => {
  it("fails every pending Deferred with AppDisconnected when the connection scope closes", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn } = yield* Scope.extend(
        makeFakeConnection("conn-drop"),
        scope,
      );

      // Two concurrent in-flight appCallback requests. Both must observe
      // `AppDisconnected` when the scope closes.
      const fiberA = yield* Effect.fork(
        sendRpcToClient(conn, AppsOnBeforeDispatch, beforeDispatchParams("A")),
      );
      const fiberB = yield* Effect.fork(
        sendRpcToClient(
          conn,
          AppsOnBeforeMessageDelivery,
          beforeMessageDeliveryParams("B"),
        ),
      );

      // Wait until both requests have registered their pending entries
      // (i.e., both writes have completed). Polling on the pending map
      // size is the deterministic synchronization point — there is no
      // setTimeout in the production code so there's nothing to "wait
      // out."
      yield* Ref.get(conn.appCallbackPending).pipe(
        Effect.flatMap((m) =>
          HashMap.size(m) === 2
            ? Effect.succeed(undefined)
            : Effect.fail(new Error("not registered yet")),
        ),
        Effect.retry({ times: 50, schedule: undefined }),
      );

      // Close the scope — the finalizer registered by
      // `acquireAppCallbackConnectionState` walks the pending map and fails
      // every Deferred with AppDisconnected.
      yield* Scope.close(scope, Exit.void);

      const exitA = yield* Fiber.join(fiberA).pipe(Effect.exit);
      const exitB = yield* Fiber.join(fiberB).pipe(Effect.exit);
      return [exitA, exitB] as const;
    });

    const [exitA, exitB] = await Effect.runPromise(program);

    const assertDisconnected = (
      exit: Exit.Exit<unknown, unknown>,
      expectedMethod: string,
    ) => {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = Cause.failureOption(exit.cause);
        expect(err._tag).toBe("Some");
        if (err._tag === "Some") {
          expect(err.value).toBeInstanceOf(AppDisconnected);
          const e = err.value as AppDisconnected;
          expect(e.method).toBe(expectedMethod);
          expect(e.connectionId).toBe("conn-drop");
        }
      }
    };
    assertDisconnected(exitA, AppsOnBeforeDispatch.name);
    assertDisconnected(exitB, AppsOnBeforeMessageDelivery.name);
  });

  it("propagates a write-time SocketError as AppCallbackRpcSocketError without leaking pending entries", async () => {
    // Construct a connection whose `write` always fails — proves the
    // pending-map cleanup branch when the write race short-circuits.
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const state = yield* Scope.extend(
        acquireAppCallbackConnectionState("conn-writefail"),
        scope,
      );
      const failingSocket = new Socket.SocketGenericError({
        reason: "Write",
        cause: new Error("simulated"),
      });
      const conn: MoltZapConnection = {
        id: "conn-writefail",
        write: () => Effect.fail(failingSocket),
        shutdown: noopShutdown,
        auth: null,
        lastPong: Date.now(),
        conversationIds: new Set<string>(),
        mutedConversations: new Set<string>(),
        appCallbackPending: state.appCallbackPending,
        appCallbackRequestCounter: state.appCallbackRequestCounter,
      };

      const exit = yield* sendRpcToClient(
        conn,
        AppsOnClose,
        onCloseParams(),
      ).pipe(Effect.exit);
      const pendingSize = HashMap.size(yield* Ref.get(conn.appCallbackPending));
      yield* Scope.close(scope, Exit.void);
      return { exit, pendingSize };
    });

    const { exit, pendingSize } = await Effect.runPromise(program);
    // Pending entry MUST be removed on socket failure or future
    // disconnect would re-fail an already-failed Deferred.
    expect(pendingSize).toBe(0);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value._tag).toBe("AppCallbackRpcSocketError");
      }
    }
  });
});

describe("sendRpcToClient — caller timeout", () => {
  it("composes with Effect.timeout at the call site (no schema-level cap)", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-timeout"),
        scope,
      );

      // Caller wraps the primitive in `Effect.timeout` — the architect
      // plan's "caller-controlled timeout" contract. The primitive itself
      // never reads a timeout; it just awaits a Deferred. If the response
      // never arrives, `Effect.timeout` fires.
      const start = Date.now();
      const exit = yield* sendRpcToClient(
        conn,
        AppsOnSessionActive,
        onSessionActiveParams(
          makeTaskId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        ),
      ).pipe(Effect.timeout(Duration.millis(100)), Effect.exit);
      const elapsed = Date.now() - start;

      // The frame WAS written (proves the primitive started its work
      // before the caller-side timeout fired).
      const written = yield* Ref.get(outbound);
      expect(written.length).toBe(1);

      yield* Scope.close(scope, Exit.void);
      return { exit, elapsed };
    });

    const { exit, elapsed } = await Effect.runPromise(program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        // `Effect.timeout`'s default failure is `TimeoutException`. The
        // primitive's typed `AppCallbackRpcError` channel does NOT include
        // timeout — it's the caller's responsibility, exactly per the
        // architect plan.
        expect(err.value._tag).toBe("TimeoutException");
      }
    }
    expect(elapsed).toBeGreaterThanOrEqual(95);
    expect(elapsed).toBeLessThan(2000);
  });

  it("interrupt cleans up the pending entry: the primitive owns cancellation cleanup", async () => {
    // Issue #310 contract: `sendRpcToClient` wraps the pending insert/
    // remove in `Effect.acquireUseRelease`, so the entry is removed on
    // interrupt before the inner exit unwinds. No need for the caller
    // to wait for scope close; no orphan accretion across long-lived
    // connections under timeout-driven interruption.
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn } = yield* Scope.extend(
        makeFakeConnection("conn-cancel"),
        scope,
      );

      const fiber = yield* Effect.fork(
        sendRpcToClient(conn, AppsOnSessionActive, onSessionActiveParams()),
      );
      yield* Ref.get(conn.appCallbackPending).pipe(
        Effect.flatMap((m) =>
          HashMap.size(m) === 1
            ? Effect.succeed(undefined)
            : Effect.fail(new Error("not registered yet")),
        ),
        Effect.retry({ times: 50, schedule: undefined }),
      );
      yield* Fiber.interrupt(fiber);
      const sizeAfterInterrupt = HashMap.size(
        yield* Ref.get(conn.appCallbackPending),
      );
      yield* Scope.close(scope, Exit.void);
      const sizeAfterScope = HashMap.size(
        yield* Ref.get(conn.appCallbackPending),
      );
      return { sizeAfterInterrupt, sizeAfterScope };
    });

    const { sizeAfterInterrupt, sizeAfterScope } =
      await Effect.runPromise(program);
    // Interrupt fires the `acquireUseRelease` release, which removes
    // the entry. Scope close is a clean no-op for this entry.
    expect(sizeAfterInterrupt).toBe(0);
    expect(sizeAfterScope).toBe(0);
  });

  it("late response after interrupt is silently dropped (Option.none from completeAppCallbackResponse)", async () => {
    // Issue #310 contract test (a): after caller interrupt, the pending
    // entry is gone, so an inbound response frame for that request id
    // finds nothing in the map. `completeAppCallbackResponse` returns
    // `Option.none()` and the inbound router treats it as a stale
    // reply. Proves the "freed Deferred re-resolve" hole is
    // structurally closed.
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-late-reply"),
        scope,
      );

      const fiber = yield* Effect.fork(
        sendRpcToClient(
          conn,
          AppsOnSessionActive,
          onSessionActiveParams(
            makeTaskId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
          ),
        ),
      );

      // Wait for the entry to be registered + the frame to be written.
      yield* Ref.get(conn.appCallbackPending).pipe(
        Effect.flatMap((m) =>
          HashMap.size(m) === 1
            ? Effect.succeed(undefined)
            : Effect.fail(new Error("not registered yet")),
        ),
        Effect.retry({ times: 50, schedule: undefined }),
      );
      const captured = yield* Ref.get(outbound).pipe(
        Effect.flatMap((xs) =>
          xs.length > 0
            ? Effect.succeed(xs[0]!)
            : Effect.fail(new Error("no frame yet")),
        ),
        Effect.retry({ times: 50, schedule: undefined }),
      );
      const { id: requestId } = parseRequestFrame(captured);

      yield* Fiber.interrupt(fiber);
      const sizeAfterInterrupt = HashMap.size(
        yield* Ref.get(conn.appCallbackPending),
      );

      // Inbound response arrives AFTER the caller was interrupted. The
      // entry is already gone; this must return `Option.none()` and
      // not throw, panic, or settle anything.
      const completed = yield* completeAppCallbackResponse(
        conn,
        responseFrame(requestId, { result: { ok: true } }),
      );

      yield* Scope.close(scope, Exit.void);
      return { sizeAfterInterrupt, completed };
    });

    const { sizeAfterInterrupt, completed } = await Effect.runPromise(program);
    expect(sizeAfterInterrupt).toBe(0);
    expect(completed._tag).toBe("None");
  });

  it("scope close after interrupt is a clean no-op (no double-fail, no panic)", async () => {
    // Issue #310 contract test (b): the disconnect-finalizer + the
    // `acquireUseRelease` release converge through the same atomic
    // `Ref.update`. Interrupt removes the entry; scope close then sees
    // an empty map and the finalizer is a no-op. Verifies no second
    // `Deferred.fail` lands on the (interrupted, never settled)
    // Deferred.
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn } = yield* Scope.extend(
        makeFakeConnection("conn-int-then-close"),
        scope,
      );

      const fiber = yield* Effect.fork(
        sendRpcToClient(conn, AppsOnClose, onCloseParams()),
      );
      yield* Ref.get(conn.appCallbackPending).pipe(
        Effect.flatMap((m) =>
          HashMap.size(m) === 1
            ? Effect.succeed(undefined)
            : Effect.fail(new Error("not registered yet")),
        ),
        Effect.retry({ times: 50, schedule: undefined }),
      );

      yield* Fiber.interrupt(fiber);
      const sizeAfterInterrupt = HashMap.size(
        yield* Ref.get(conn.appCallbackPending),
      );

      // Scope close runs the disconnect finalizer on an empty map.
      // Should not throw, should not log, should not affect the
      // already-interrupted fiber's exit.
      const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

      const fiberExit = yield* Fiber.await(fiber);
      const sizeAfterScope = HashMap.size(
        yield* Ref.get(conn.appCallbackPending),
      );

      return { sizeAfterInterrupt, sizeAfterScope, closeExit, fiberExit };
    });

    const { sizeAfterInterrupt, sizeAfterScope, closeExit, fiberExit } =
      await Effect.runPromise(program);
    expect(sizeAfterInterrupt).toBe(0);
    expect(sizeAfterScope).toBe(0);
    // Scope close itself is a clean success.
    expect(Exit.isSuccess(closeExit)).toBe(true);
    // Interrupted fiber stays interrupted; the late finalizer didn't
    // re-fail the (already-released) Deferred into a typed error.
    expect(Exit.isInterrupted(fiberExit)).toBe(true);
  });

  it("Effect.timeout firing removes the pending entry (B.3 callsite shape)", async () => {
    // Issue #310 contract test (c): the canonical B.3 callsite is
    // `wrapHookEffectWithEnvelope` wrapping `sendRpcToClient` with
    // `Effect.timeout`. `Effect.timeout` works by interrupting the
    // inner fiber on fire. With the new contract, that interrupt fires
    // the release, and the pending entry is removed *before* the
    // timeout exit unwinds. No orphan accretion across N-hooks/sec on
    // a long-lived connection.
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-timeout-drain"),
        scope,
      );

      const exit = yield* sendRpcToClient(
        conn,
        AppsOnSessionActive,
        onSessionActiveParams(
          makeTaskId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        ),
      ).pipe(Effect.timeout(Duration.millis(50)), Effect.exit);

      // Frame was written before timeout fired (proves the primitive
      // started its work).
      const written = yield* Ref.get(outbound);
      const sizeAfterTimeout = HashMap.size(
        yield* Ref.get(conn.appCallbackPending),
      );

      yield* Scope.close(scope, Exit.void);
      return { exit, writtenLen: written.length, sizeAfterTimeout };
    });

    const { exit, writtenLen, sizeAfterTimeout } =
      await Effect.runPromise(program);
    expect(writtenLen).toBe(1);
    expect(sizeAfterTimeout).toBe(0);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value._tag).toBe("TimeoutException");
      }
    }
  });
});

// Compile-time guard: if a new tagged variant lands in `AppCallbackRpcError`
// without a matching test branch above, this assignment stops compiling.
type _ExhaustiveAppCallbackTags =
  | "AppDisconnected"
  | "AppCallbackRpcResponseError"
  | "AppCallbackRpcDecodeError"
  | "AppCallbackRpcSocketError";
const _exhaustive: _ExhaustiveAppCallbackTags = "AppDisconnected";
void _exhaustive;
