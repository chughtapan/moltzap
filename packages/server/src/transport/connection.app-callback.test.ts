/**
 * Phase 1.0 (B.1) gating tests for the server-initiated awaitable RPC
 * primitives. Three scenarios - happy-path round-trip, disconnect mid-
 * request, caller timeout - exercise the contract that AppHost (B.3)
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
 * `conn.originator.resolve` directly. This keeps the round-trip a
 * pure-Effect test of the protocol primitive; wire integration is
 * covered by B.9.
 */
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import {
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Schedule,
  Scope,
} from "effect";
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
  type AgentClientConnection,
  type RequestFrame,
} from "@moltzap/protocol";
import {
  agentId,
  conversationId,
  messageId,
  taskId as makeTaskId,
  validateRequestFrame,
} from "@moltzap/protocol/testing";

const it = effectIt.live;

const noopShutdown: MoltZapConnection["shutdown"] = Effect.void;
const TASK_ID = makeTaskId("11111111-1111-4111-8111-111111111111");
const HAPPY_TASK_ID = makeTaskId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const TIMEOUT_TASK_ID = makeTaskId("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const LATE_RESPONSE_TASK_ID = makeTaskId(
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
);
const APP_ID = "test-app";
const AGENT_ID = agentId("22222222-2222-4222-8222-222222222222");
const CONVERSATION_ID = conversationId("33333333-3333-4333-8333-333333333333");
const MESSAGE_ID = messageId("44444444-4444-4444-8444-444444444444");
const PARTICIPANT = { agentId: AGENT_ID, ownerId: "owner-a" } as const;
const GRANTED_ADMISSION = { admission: { decision: "grant" } } as const;
const HANDLER_DEFECT_CODE = -32999;
const TASK_ALREADY_CLOSED_MESSAGE = "task-already-closed";
const CALLER_TIMEOUT_MS = 100;
const MIN_TIMEOUT_ELAPSED_MS = 95;
const MAX_TIMEOUT_ELAPSED_MS = 2000;
const DRAIN_TIMEOUT_MS = 50;
const OUTBOUND_RETRY_COUNT = 50;
const TIMEOUT_EXCEPTION_TAG = "TimeoutException";

class OutboundFramesMissing extends Data.TaggedError("OutboundFramesMissing")<{
  readonly expected: number;
  readonly written: number;
}> {
  override get message(): string {
    return `only ${this.written} of ${this.expected} frames written`;
  }
}

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

interface ManualFakeConnSetup extends FakeConnSetup {
  readonly scope: Scope.CloseableScope;
}

describe("sendRpcToClient round-trip", () => {
  it("encodes a task callback request and returns the matching response", () =>
    happyRoundTrip());

  it("propagates a typed error response as RpcServerError", () =>
    typedErrorResponse());
});

describe("sendRpcToClient disconnect cleanup", () => {
  it("fails every pending Deferred with NotConnectedError on scope close", () =>
    disconnectFailsPending());

  it("propagates a write-time SocketError as NotConnectedError", () =>
    writeFailureSurfacesNotConnected());
});

describe("sendRpcToClient caller timeout", () => {
  it("composes with Effect.timeout at the call site", () => callerTimeout());

  it("drops a late response after caller interrupt", () =>
    lateResponseAfterInterrupt());
});

describe("sendRpcToClient timeout cleanup", () => {
  it("scope close after interrupt is a clean no-op", () =>
    scopeCloseAfterInterruptClean());

  it("drops a late response after Effect.timeout fires", () =>
    timeoutDropsLateResponse());
});

function happyRoundTrip() {
  return useFakeConnection("conn-happy", ({ conn, outbound }) =>
    Effect.gen(function* () {
      const params = authorizeDispatchParams("happy", HAPPY_TASK_ID);
      const fiber = yield* forkDispatchAuthorize(conn, params);
      const frame = yield* waitForRequestFrame(outbound);

      expect(frame.method).toBe(DispatchAuthorize.name);
      expect(frame.params).toEqual(params);
      expect(frame.id.startsWith("srv-conn-happy-")).toBe(true);

      const matched = yield* conn.originator.resolve(
        DispatchAuthorize.encodeResponse(frame.id, GRANTED_ADMISSION),
      );
      expect(matched).toBe(true);

      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);
      expect(expectSuccess(exit)).toEqual(GRANTED_ADMISSION);
    }),
  );
}

function typedErrorResponse() {
  return useFakeConnection("conn-err", ({ conn, outbound }) =>
    Effect.gen(function* () {
      const fiber = yield* forkDispatchAuthorize(
        conn,
        authorizeDispatchParams("err"),
      );
      const { id } = yield* waitForRequestFrame(outbound);

      yield* conn.originator.resolve(
        encodeErrorResponse(id, {
          code: HANDLER_DEFECT_CODE,
          message: TASK_ALREADY_CLOSED_MESSAGE,
        }),
      );

      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);
      const failure = expectRpcServerError(exit);
      expect(failure.code).toBe(HANDLER_DEFECT_CODE);
      expect(failure.message).toBe(TASK_ALREADY_CLOSED_MESSAGE);
    }),
  );
}

function disconnectFailsPending() {
  return Effect.gen(function* () {
    const { conn, outbound, scope } =
      yield* createManualFakeConnection("conn-drop");
    const fiberA = yield* forkDispatchAuthorize(
      conn,
      authorizeDispatchParams("A"),
    );
    const fiberB = yield* forkDispatchAuthorize(
      conn,
      authorizeDispatchParams("B"),
    );

    yield* waitForOutbound(outbound, 2);
    yield* Scope.close(scope, Exit.void);

    const exitA = yield* Fiber.join(fiberA).pipe(Effect.exit);
    const exitB = yield* Fiber.join(fiberB).pipe(Effect.exit);
    expectNotConnected(exitA);
    expectNotConnected(exitB);
  });
}

function writeFailureSurfacesNotConnected() {
  return Effect.scoped(
    Effect.gen(function* () {
      const failingSocket = new Socket.SocketGenericError({
        reason: "Write",
        cause: "simulated",
      });
      const failingWrite: MoltZapConnection["write"] = () =>
        Effect.fail(failingSocket);
      const originator = yield* acquireConnectionRpcClient(
        "conn-writefail",
        failingWrite,
      );
      const conn = makeConnection("conn-writefail", failingWrite, originator);

      const exit = yield* sendRpcToClient(
        conn,
        DispatchAuthorize,
        authorizeDispatchParams("writefail"),
      ).pipe(Effect.exit);
      expectNotConnected(exit);
    }),
  );
}

function callerTimeout() {
  return useFakeConnection("conn-timeout", ({ conn, outbound }) =>
    Effect.gen(function* () {
      const start = Date.now();
      const exit = yield* sendRpcToClient(
        conn,
        DispatchAuthorize,
        authorizeDispatchParams("timeout", TIMEOUT_TASK_ID),
      ).pipe(Effect.timeout(Duration.millis(CALLER_TIMEOUT_MS)), Effect.exit);
      const elapsed = Date.now() - start;

      const written = yield* Ref.get(outbound);
      expect(written.length).toBe(1);
      expectTimeoutFailure(exit);
      expect(elapsed).toBeGreaterThanOrEqual(MIN_TIMEOUT_ELAPSED_MS);
      expect(elapsed).toBeLessThan(MAX_TIMEOUT_ELAPSED_MS);
    }),
  );
}

function lateResponseAfterInterrupt() {
  return useFakeConnection("conn-late-reply", ({ conn, outbound }) =>
    Effect.gen(function* () {
      const fiber = yield* forkDispatchAuthorize(
        conn,
        authorizeDispatchParams("late", LATE_RESPONSE_TASK_ID),
      );
      const { id: requestId } = yield* waitForRequestFrame(outbound);

      yield* Fiber.interrupt(fiber);
      const matched = yield* conn.originator.resolve(
        DispatchAuthorize.encodeResponse(requestId, GRANTED_ADMISSION),
      );

      expect(matched).toBe(false);
    }),
  );
}

function scopeCloseAfterInterruptClean() {
  return Effect.gen(function* () {
    const { conn, outbound, scope } = yield* createManualFakeConnection(
      "conn-int-then-close",
    );
    const fiber = yield* forkDispatchAuthorize(
      conn,
      authorizeDispatchParams("int"),
    );
    yield* waitForOutbound(outbound, 1);

    yield* Fiber.interrupt(fiber);
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);
    const fiberExit = yield* Fiber.await(fiber);

    expect(Exit.isSuccess(closeExit)).toBe(true);
    expect(Exit.isInterrupted(fiberExit)).toBe(true);
  });
}

function timeoutDropsLateResponse() {
  return useFakeConnection("conn-timeout-drain", ({ conn, outbound }) =>
    Effect.gen(function* () {
      const exit = yield* sendRpcToClient(
        conn,
        DispatchAuthorize,
        authorizeDispatchParams("drain", TIMEOUT_TASK_ID),
      ).pipe(Effect.timeout(Duration.millis(DRAIN_TIMEOUT_MS)), Effect.exit);

      const written = yield* Ref.get(outbound);
      const { id: requestId } = parseRequestFrame(written[0]!);
      const matched = yield* conn.originator.resolve(
        DispatchAuthorize.encodeResponse(requestId, GRANTED_ADMISSION),
      );

      expect(written.length).toBe(1);
      expect(matched).toBe(false);
      expectTimeoutFailure(exit);
    }),
  );
}

function makeConnection(
  id: string,
  write: MoltZapConnection["write"],
  originator: AgentClientConnection,
): MoltZapConnection {
  return {
    id,
    write,
    shutdown: noopShutdown,
    auth: null,
    lastPong: Date.now(),
    conversationIds: new Set<string>(),
    mutedConversations: new Set<string>(),
    originator,
  };
}

/**
 * Build a `MoltZapConnection` whose `write` records outbound frames into a
 * Ref. Caller can inspect the captured frame, then synthesize the matching
 * inbound response via `conn.originator.resolve`.
 */
const makeFakeConnection = (
  connId: string,
): Effect.Effect<FakeConnSetup, never, Scope.Scope> =>
  Effect.gen(function* () {
    const outbound = yield* Ref.make<ReadonlyArray<string>>([]);
    const write: MoltZapConnection["write"] = (raw) =>
      Ref.update(outbound, (xs) => [...xs, raw]);
    const originator = yield* acquireConnectionRpcClient(connId, write);
    return { conn: makeConnection(connId, write, originator), outbound };
  });

function useFakeConnection<A, E>(
  connId: string,
  run: (setup: FakeConnSetup) => Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return Effect.scoped(makeFakeConnection(connId).pipe(Effect.flatMap(run)));
}

function createManualFakeConnection(
  connId: string,
): Effect.Effect<ManualFakeConnSetup> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const setup = yield* Scope.extend(makeFakeConnection(connId), scope);
    return { ...setup, scope };
  });
}

function forkDispatchAuthorize(
  conn: MoltZapConnection,
  params: ReturnType<typeof authorizeDispatchParams>,
) {
  return Effect.fork(sendRpcToClient(conn, DispatchAuthorize, params));
}

function parseRequestFrame(raw: string): RequestFrame {
  const parsed: unknown = JSON.parse(raw);
  if (!validateRequestFrame(parsed)) {
    expect.fail("expected JSON-RPC request frame");
  }
  return parsed;
}

function waitForRequestFrame(
  outbound: Ref.Ref<ReadonlyArray<string>>,
): Effect.Effect<RequestFrame> {
  return waitForOutbound(outbound, 1).pipe(
    Effect.map((written) => parseRequestFrame(written[0]!)),
  );
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
        : Effect.fail(
            new OutboundFramesMissing({ written: xs.length, expected: n }),
          ),
    ),
    Effect.retry(Schedule.recurs(OUTBOUND_RETRY_COUNT)),
    Effect.orDie,
  );

function expectSuccess<A>(exit: Exit.Exit<A, unknown>): A {
  expect(Exit.isSuccess(exit)).toBe(true);
  if (!Exit.isSuccess(exit)) expect.fail("expected success exit");
  return exit.value;
}

function expectFailure(exit: Exit.Exit<unknown, unknown>): unknown {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) expect.fail("expected failure exit");
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure)) expect.fail("expected typed failure");
  return failure.value;
}

function expectRpcServerError(
  exit: Exit.Exit<unknown, unknown>,
): RpcServerError {
  const failure = expectFailure(exit);
  expect(failure).toBeInstanceOf(RpcServerError);
  return failure as RpcServerError;
}

function expectNotConnected(exit: Exit.Exit<unknown, unknown>): void {
  expect(expectFailure(exit)).toBeInstanceOf(NotConnectedError);
}

function expectTimeoutFailure(exit: Exit.Exit<unknown, unknown>): void {
  const failure = expectFailure(exit);
  expect((failure as { readonly _tag?: string })._tag).toBe(
    TIMEOUT_EXCEPTION_TAG,
  );
}
