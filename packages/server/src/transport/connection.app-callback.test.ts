/**
 * Phase 1.0 (B.1) gating tests for the server-initiated awaitable RPC
 * primitives. Three scenarios — happy-path round-trip, disconnect mid-
 * request, caller timeout — exercise the contract that AppHost (B.3)
 * relies on.
 *
 * Phase 12 S8a: server-side encapsulation. The Refs that previously
 * lived on `MoltZapConnection` (`appCallbackPending`,
 * `appCallbackRequestCounter`) are gone; their work is done inside the
 * connection's `JsonRpcClient`. Tests verify cleanup invariants through
 * observable behavior (exit shape, late-response `resolve` returning
 * `false`) rather than by reading the pending map's size.
 *
 * The tests run against `MoltZapConnection` directly: no testcontainers,
 * no real WebSocket. The connection's `write` is a mock that records
 * outbound frames, and inbound responses are injected by calling
 * `conn.jsonRpcClient.resolve` directly. This keeps the round-trip a
 * pure-Effect test of the protocol primitive — wire integration is
 * covered by B.9.
 */
import { describe, expect, it } from "vitest";
import { Cause, Duration, Effect, Exit, Fiber, Ref, Scope } from "effect";
import * as Socket from "@effect/platform/Socket";
import {
  acquireConnectionRpcClient,
  sendRpcToClient,
  type MoltZapConnection,
} from "./connection.js";

import {
  NotConnectedError,
  RpcServerError,
  DispatchAuthorize,
  encodeErrorResponse,
  type RequestFrame,
} from "@moltzap/protocol";
import {
  agentId,
  conversationId,
  messageId,
  taskId as makeTaskId,
  validateRequestFrame,
} from "@moltzap/protocol/testing";

const noopShutdown: MoltZapConnection["shutdown"] = Effect.void;
const TASK_ID = makeTaskId("11111111-1111-4111-8111-111111111111");
const APP_ID = "test-app";
const AGENT_ID = agentId("22222222-2222-4222-8222-222222222222");
const CONVERSATION_ID = conversationId("33333333-3333-4333-8333-333333333333");
const MESSAGE_ID = messageId("44444444-4444-4444-8444-444444444444");
const PARTICIPANT = { agentId: AGENT_ID, ownerId: "owner-a" } as const;

const authorizeDispatchParams = (text: string, taskId = TASK_ID) => ({
  taskId,
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

interface FakeConnSetup {
  readonly conn: MoltZapConnection;
  readonly outbound: Ref.Ref<ReadonlyArray<string>>;
}

/**
 * Build a `MoltZapConnection` whose `write` records outbound frames into
 * a Ref. Caller can inspect the captured frame, then synthesize the
 * matching inbound response via `conn.jsonRpcClient.resolve`.
 *
 * `acquireConnectionRpcClient` registers the disconnect-finalizer on the
 * surrounding scope; tests close the scope to drive the failure path.
 */
const makeFakeConnection = (
  connId: string,
): Effect.Effect<FakeConnSetup, never, Scope.Scope> =>
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

function parseRequestFrame(raw: string): RequestFrame {
  const parsed: unknown = JSON.parse(raw);
  if (!validateRequestFrame(parsed)) {
    throw new Error("expected JSON-RPC request frame");
  }
  return parsed;
}

/** Poll the outbound Ref until it has at least `n` frames and return them. */
const waitForOutbound = (
  outbound: Ref.Ref<ReadonlyArray<string>>,
  n: number,
): Effect.Effect<ReadonlyArray<string>> =>
  Ref.get(outbound).pipe(
    Effect.flatMap((xs) =>
      xs.length >= n
        ? Effect.succeed(xs)
        : Effect.fail(new Error(`only ${xs.length} of ${n} frames written`)),
    ),
    Effect.retry({ times: 50, schedule: undefined }),
    Effect.orDie,
  );

describe("sendRpcToClient — happy-path round-trip", () => {
  it("encodes a task-callback request, awaits the matching response, and returns the result", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-happy"),
        scope,
      );

      // Fork the request — sendRpcToClient parks on a Deferred until the
      // matching response is `resolve`d. Forking lets the test thread
      // synthesize the response.
      const params = authorizeDispatchParams(
        "happy",
        makeTaskId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      );
      const fiber = yield* Effect.fork(
        sendRpcToClient(conn, DispatchAuthorize, params),
      );

      const written = yield* waitForOutbound(outbound, 1);
      const frame = parseRequestFrame(written[0]!);
      expect(frame.method).toBe(DispatchAuthorize.name);
      expect(frame.params).toEqual(params);
      // `srv-<connId>-<seq>` namespace prefix keeps server-minted ids
      // disjoint from client-minted request ids.
      expect(frame.id.startsWith("srv-conn-happy-")).toBe(true);

      // Synthesize the matching response and route it through the
      // server's inbound completion path.
      const matched = yield* conn.jsonRpcClient.resolve(
        DispatchAuthorize.encodeResponse(frame.id, {
          admission: { decision: "grant" },
        }),
      );
      expect(matched).toBe(true);

      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);
      yield* Scope.close(scope, Exit.void);
      return exit;
    });

    const exit = await Effect.runPromise(program);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({ admission: { decision: "grant" } });
    }
  });

  it("propagates a typed error response as RpcServerError", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-err"),
        scope,
      );

      const fiber = yield* Effect.fork(
        sendRpcToClient(
          conn,
          DispatchAuthorize,
          authorizeDispatchParams("err"),
        ),
      );

      const written = yield* waitForOutbound(outbound, 1);
      const { id } = parseRequestFrame(written[0]!);

      yield* conn.jsonRpcClient.resolve(
        encodeErrorResponse(id, {
          code: -32999,
          message: "task-already-closed",
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
        expect(err.value).toBeInstanceOf(RpcServerError);
        const e = err.value as RpcServerError;
        expect(e.code).toBe(-32999);
        expect(e.message).toBe("task-already-closed");
      }
    }
  });
});

describe("sendRpcToClient — disconnect mid-request", () => {
  it("fails every pending Deferred with NotConnectedError when the connection scope closes", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-drop"),
        scope,
      );

      // Two concurrent in-flight task-callback requests. Both must observe
      // `NotConnectedError` when the scope closes.
      const fiberA = yield* Effect.fork(
        sendRpcToClient(conn, DispatchAuthorize, authorizeDispatchParams("A")),
      );
      const fiberB = yield* Effect.fork(
        sendRpcToClient(conn, DispatchAuthorize, authorizeDispatchParams("B")),
      );

      // Both writes have landed in the outbound Ref → both calls have
      // registered their pending entries inside the JsonRpcClient.
      yield* waitForOutbound(outbound, 2);

      // Close the scope — the JsonRpcClient's Scope finalizer drains
      // every pending Deferred with `NotConnectedError`.
      yield* Scope.close(scope, Exit.void);

      const exitA = yield* Fiber.join(fiberA).pipe(Effect.exit);
      const exitB = yield* Fiber.join(fiberB).pipe(Effect.exit);
      return [exitA, exitB] as const;
    });

    const [exitA, exitB] = await Effect.runPromise(program);

    const assertDisconnected = (exit: Exit.Exit<unknown, unknown>) => {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = Cause.failureOption(exit.cause);
        expect(err._tag).toBe("Some");
        if (err._tag === "Some") {
          expect(err.value).toBeInstanceOf(NotConnectedError);
        }
      }
    };
    assertDisconnected(exitA);
    assertDisconnected(exitB);
  });

  it("propagates a write-time SocketError as NotConnectedError", async () => {
    // Construct a connection whose `write` always fails — proves the
    // pending cleanup branch when the write race short-circuits.
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const failingSocket = new Socket.SocketGenericError({
        reason: "Write",
        cause: new Error("simulated"),
      });
      const failingWrite: MoltZapConnection["write"] = () =>
        Effect.fail(failingSocket);
      const jsonRpcClient = yield* Scope.extend(
        acquireConnectionRpcClient("conn-writefail", failingWrite),
        scope,
      );
      const conn: MoltZapConnection = {
        id: "conn-writefail",
        write: failingWrite,
        shutdown: noopShutdown,
        auth: null,
        lastPong: Date.now(),
        conversationIds: new Set<string>(),
        mutedConversations: new Set<string>(),
        jsonRpcClient,
      };

      const exit = yield* sendRpcToClient(
        conn,
        DispatchAuthorize,
        authorizeDispatchParams("writefail"),
      ).pipe(Effect.exit);
      yield* Scope.close(scope, Exit.void);
      return exit;
    });

    const exit = await Effect.runPromise(program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(NotConnectedError);
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
        DispatchAuthorize,
        authorizeDispatchParams(
          "timeout",
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
        // primitive's error channel does not include timeouts —
        // those are the caller's responsibility.
        expect(err.value._tag).toBe("TimeoutException");
      }
    }
    expect(elapsed).toBeGreaterThanOrEqual(95);
    expect(elapsed).toBeLessThan(2000);
  });

  it("late response after interrupt: resolve returns false, no Deferred re-resolve", async () => {
    // Issue #310 contract: after caller interrupt, the pending entry is
    // gone. An inbound response frame for that request id finds nothing
    // and `jsonRpcClient.resolve` returns `false`. Proves the
    // "freed Deferred re-resolve" hole is structurally closed.
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-late-reply"),
        scope,
      );

      const fiber = yield* Effect.fork(
        sendRpcToClient(
          conn,
          DispatchAuthorize,
          authorizeDispatchParams(
            "late",
            makeTaskId("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
          ),
        ),
      );

      const written = yield* waitForOutbound(outbound, 1);
      const { id: requestId } = parseRequestFrame(written[0]!);

      yield* Fiber.interrupt(fiber);

      // Inbound response arrives AFTER the caller was interrupted. The
      // entry is already gone; `resolve` returns `false` and does not
      // throw, panic, or settle anything.
      const matched = yield* conn.jsonRpcClient.resolve(
        DispatchAuthorize.encodeResponse(requestId, {
          admission: { decision: "grant" },
        }),
      );

      yield* Scope.close(scope, Exit.void);
      return matched;
    });

    const matched = await Effect.runPromise(program);
    expect(matched).toBe(false);
  });

  it("scope close after interrupt is a clean no-op", async () => {
    // Issue #310 contract: interrupt removes the entry; subsequent scope
    // close finalizer sees an empty map and is a no-op. Verifies no
    // second `Deferred.fail` lands on the (interrupted, never settled)
    // Deferred.
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-int-then-close"),
        scope,
      );

      const fiber = yield* Effect.fork(
        sendRpcToClient(
          conn,
          DispatchAuthorize,
          authorizeDispatchParams("int"),
        ),
      );
      yield* waitForOutbound(outbound, 1);

      yield* Fiber.interrupt(fiber);
      const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);
      const fiberExit = yield* Fiber.await(fiber);

      return { closeExit, fiberExit };
    });

    const { closeExit, fiberExit } = await Effect.runPromise(program);
    // Scope close itself is a clean success.
    expect(Exit.isSuccess(closeExit)).toBe(true);
    // Interrupted fiber stays interrupted; the late finalizer didn't
    // re-fail the (already-released) Deferred into a typed error.
    expect(Exit.isInterrupted(fiberExit)).toBe(true);
  });

  it("Effect.timeout firing surfaces TimeoutException; subsequent late response is dropped", async () => {
    // Issue #310 contract: the canonical B.3 callsite is
    // `wrapHookEffectWithEnvelope` wrapping `sendRpcToClient` with
    // `Effect.timeout`. `Effect.timeout` interrupts the inner fiber,
    // which fires the JsonRpcClient's onExit cleanup. A subsequent
    // late inbound response for the timed-out id finds nothing in the
    // pending map.
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-timeout-drain"),
        scope,
      );

      const exit = yield* sendRpcToClient(
        conn,
        DispatchAuthorize,
        authorizeDispatchParams(
          "drain",
          makeTaskId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        ),
      ).pipe(Effect.timeout(Duration.millis(50)), Effect.exit);

      // Frame was written before timeout fired (proves the primitive
      // started its work).
      const written = yield* Ref.get(outbound);
      const { id: requestId } = parseRequestFrame(written[0]!);

      // Late response after timeout: `resolve` finds nothing.
      const matched = yield* conn.jsonRpcClient.resolve(
        DispatchAuthorize.encodeResponse(requestId, {
          admission: { decision: "grant" },
        }),
      );

      yield* Scope.close(scope, Exit.void);
      return { exit, writtenLen: written.length, matched };
    });

    const { exit, writtenLen, matched } = await Effect.runPromise(program);
    expect(writtenLen).toBe(1);
    expect(matched).toBe(false);
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
