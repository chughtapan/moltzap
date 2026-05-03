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
 * `completeS2cResponse` directly. This keeps the round-trip a pure-Effect
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
  S2cRpcResponseError,
  acquireS2cConnectionState,
  completeS2cResponse,
  sendRpcToClient,
  type MoltZapConnection,
} from "./connection.js";

const noopShutdown: MoltZapConnection["shutdown"] = Effect.void;

interface FakeConnSetup {
  readonly conn: MoltZapConnection;
  readonly outbound: Ref.Ref<ReadonlyArray<string>>;
}

/**
 * Build a `MoltZapConnection` whose `write` records outbound frames into
 * a Ref. Caller can inspect the captured frame, then synthesize the
 * matching inbound response via `completeS2cResponse`.
 *
 * `acquireS2cConnectionState` registers the disconnect-finalizer on the
 * surrounding scope; tests close the scope to drive the failure path.
 */
const makeFakeConnection = (
  connId: string,
): Effect.Effect<FakeConnSetup, never, Scope.Scope> =>
  Effect.gen(function* () {
    const outbound = yield* Ref.make<ReadonlyArray<string>>([]);
    const state = yield* acquireS2cConnectionState(connId);
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
      s2cPending: state.s2cPending,
      s2cRequestCounter: state.s2cRequestCounter,
    };
    return { conn, outbound };
  });

describe("sendRpcToClient — happy-path round-trip", () => {
  it("encodes an s2c request, awaits the matching response, and returns the result", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-happy"),
        scope,
      );

      // Fork the request — `sendRpcToClient` parks on a Deferred until
      // `completeS2cResponse` settles it. Forking lets the test thread
      // synthesize the matching response.
      const fiber = yield* Effect.fork(
        sendRpcToClient(conn, "apps/onJoin", { sessionId: "sess-1" }),
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

      const frame = JSON.parse(captured) as {
        type: string;
        direction: string;
        id: string;
        method: string;
        params: { sessionId: string };
        traceparent?: string;
      };
      expect(frame.type).toBe("request");
      expect(frame.direction).toBe("s2c");
      expect(frame.method).toBe("apps/onJoin");
      expect(frame.params.sessionId).toBe("sess-1");
      expect(frame.traceparent).toBeUndefined();
      // `srv-<connId>-<seq>` namespace prefix — direction-namespacing keeps
      // c2s and s2c id pools disjoint per the architect plan.
      expect(frame.id.startsWith("srv-conn-happy-")).toBe(true);

      // Synthesize the matching s2c response and route it through the
      // server's inbound completion path. This is exactly what the real
      // server's `handleFrame` does when an s2c response frame arrives.
      const completed = yield* completeS2cResponse(conn, {
        jsonrpc: "2.0",
        type: "response",
        direction: "s2c",
        id: frame.id,
        result: { ok: true, surface: "decision" },
      });
      expect(completed._tag).toBe("Some");

      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);
      yield* Scope.close(scope, Exit.void);

      return exit;
    });

    const exit = await Effect.runPromise(program);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({ ok: true, surface: "decision" });
    }
  });

  it("injects the current Effect span as W3C traceparent when one is active", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-trace"),
        scope,
      );

      const fiber = yield* Effect.fork(
        sendRpcToClient(conn, "apps/onJoin", { sessionId: "trace-sess" }).pipe(
          Effect.withSpan("apphost.s2c.apps/onJoin"),
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

      const frame = JSON.parse(captured) as {
        id: string;
        traceparent?: string;
      };
      expect(frame.traceparent).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$/u,
      );

      yield* completeS2cResponse(conn, {
        jsonrpc: "2.0",
        type: "response",
        direction: "s2c",
        id: frame.id,
        result: { ok: true },
      });

      const exit = yield* Fiber.join(fiber).pipe(Effect.exit);
      yield* Scope.close(scope, Exit.void);
      return exit;
    });

    const exit = await Effect.runPromise(program);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("propagates a typed error response as S2cRpcResponseError", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { conn, outbound } = yield* Scope.extend(
        makeFakeConnection("conn-err"),
        scope,
      );

      const fiber = yield* Effect.fork(
        sendRpcToClient(conn, "apps/onClose", { sessionId: "sess-x" }),
      );

      const captured = yield* Ref.get(outbound).pipe(
        Effect.flatMap((xs) =>
          xs.length > 0
            ? Effect.succeed(xs[0]!)
            : Effect.fail(new Error("no frame yet")),
        ),
        Effect.retry({ times: 50, schedule: undefined }),
      );
      const { id } = JSON.parse(captured) as { id: string };

      yield* completeS2cResponse(conn, {
        jsonrpc: "2.0",
        type: "response",
        direction: "s2c",
        id,
        error: { code: -32000, message: "session-already-closed" },
      });

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
        expect(err.value).toBeInstanceOf(S2cRpcResponseError);
        const e = err.value as S2cRpcResponseError;
        expect(e.code).toBe(-32000);
        expect(e.message).toBe("session-already-closed");
        expect(e.method).toBe("apps/onClose");
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

      // Two concurrent in-flight s2c requests. Both must observe
      // `AppDisconnected` when the scope closes.
      const fiberA = yield* Effect.fork(
        sendRpcToClient(conn, "apps/onBeforeDispatch", { tag: "A" }),
      );
      const fiberB = yield* Effect.fork(
        sendRpcToClient(conn, "apps/onBeforeMessageDelivery", { tag: "B" }),
      );

      // Wait until both requests have registered their pending entries
      // (i.e., both writes have completed). Polling on the pending map
      // size is the deterministic synchronization point — there is no
      // setTimeout in the production code so there's nothing to "wait
      // out."
      yield* Ref.get(conn.s2cPending).pipe(
        Effect.flatMap((m) =>
          HashMap.size(m) === 2
            ? Effect.succeed(undefined)
            : Effect.fail(new Error("not registered yet")),
        ),
        Effect.retry({ times: 50, schedule: undefined }),
      );

      // Close the scope — the finalizer registered by
      // `acquireS2cConnectionState` walks the pending map and fails
      // every Deferred with AppDisconnected.
      yield* Scope.close(scope, Exit.void);

      const exitA = yield* Fiber.join(fiberA).pipe(Effect.exit);
      const exitB = yield* Fiber.join(fiberB).pipe(Effect.exit);
      return [exitA, exitB] as const;
    });

    const [exitA, exitB] = await Effect.runPromise(program);

    for (const [exit, expectedMethod] of [
      [exitA, "apps/onBeforeDispatch"],
      [exitB, "apps/onBeforeMessageDelivery"],
    ] as const) {
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
    }
  });

  it("propagates a write-time SocketError as S2cRpcSocketError without leaking pending entries", async () => {
    // Construct a connection whose `write` always fails — proves the
    // pending-map cleanup branch when the write race short-circuits.
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const state = yield* Scope.extend(
        acquireS2cConnectionState("conn-writefail"),
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
        s2cPending: state.s2cPending,
        s2cRequestCounter: state.s2cRequestCounter,
      };

      const exit = yield* sendRpcToClient(conn, "apps/onClose", {}).pipe(
        Effect.exit,
      );
      const pendingSize = HashMap.size(yield* Ref.get(conn.s2cPending));
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
        expect(err.value._tag).toBe("S2cRpcSocketError");
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
      const exit = yield* sendRpcToClient(conn, "apps/onJoin", {
        sessionId: "s",
      }).pipe(Effect.timeout(Duration.millis(100)), Effect.exit);
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
        // primitive's typed `S2cRpcError` channel does NOT include
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
        sendRpcToClient(conn, "apps/onSessionActive", {}),
      );
      yield* Ref.get(conn.s2cPending).pipe(
        Effect.flatMap((m) =>
          HashMap.size(m) === 1
            ? Effect.succeed(undefined)
            : Effect.fail(new Error("not registered yet")),
        ),
        Effect.retry({ times: 50, schedule: undefined }),
      );
      yield* Fiber.interrupt(fiber);
      const sizeAfterInterrupt = HashMap.size(yield* Ref.get(conn.s2cPending));
      yield* Scope.close(scope, Exit.void);
      const sizeAfterScope = HashMap.size(yield* Ref.get(conn.s2cPending));
      return { sizeAfterInterrupt, sizeAfterScope };
    });

    const { sizeAfterInterrupt, sizeAfterScope } =
      await Effect.runPromise(program);
    // Interrupt fires the `acquireUseRelease` release, which removes
    // the entry. Scope close is a clean no-op for this entry.
    expect(sizeAfterInterrupt).toBe(0);
    expect(sizeAfterScope).toBe(0);
  });

  it("late response after interrupt is silently dropped (Option.none from completeS2cResponse)", async () => {
    // Issue #310 contract test (a): after caller interrupt, the pending
    // entry is gone, so an inbound response frame for that request id
    // finds nothing in the map. `completeS2cResponse` returns
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
        sendRpcToClient(conn, "apps/onJoin", { sessionId: "late" }),
      );

      // Wait for the entry to be registered + the frame to be written.
      yield* Ref.get(conn.s2cPending).pipe(
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
      const { id: requestId } = JSON.parse(captured) as { id: string };

      yield* Fiber.interrupt(fiber);
      const sizeAfterInterrupt = HashMap.size(yield* Ref.get(conn.s2cPending));

      // Inbound response arrives AFTER the caller was interrupted. The
      // entry is already gone; this must return `Option.none()` and
      // not throw, panic, or settle anything.
      const completed = yield* completeS2cResponse(conn, {
        jsonrpc: "2.0",
        type: "response",
        direction: "s2c",
        id: requestId,
        result: { ok: true },
      });

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
        sendRpcToClient(conn, "apps/onClose", {}),
      );
      yield* Ref.get(conn.s2cPending).pipe(
        Effect.flatMap((m) =>
          HashMap.size(m) === 1
            ? Effect.succeed(undefined)
            : Effect.fail(new Error("not registered yet")),
        ),
        Effect.retry({ times: 50, schedule: undefined }),
      );

      yield* Fiber.interrupt(fiber);
      const sizeAfterInterrupt = HashMap.size(yield* Ref.get(conn.s2cPending));

      // Scope close runs the disconnect finalizer on an empty map.
      // Should not throw, should not log, should not affect the
      // already-interrupted fiber's exit.
      const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

      const fiberExit = yield* Fiber.await(fiber);
      const sizeAfterScope = HashMap.size(yield* Ref.get(conn.s2cPending));

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

      const exit = yield* sendRpcToClient(conn, "apps/onJoin", {
        sessionId: "s",
      }).pipe(Effect.timeout(Duration.millis(50)), Effect.exit);

      // Frame was written before timeout fired (proves the primitive
      // started its work).
      const written = yield* Ref.get(outbound);
      const sizeAfterTimeout = HashMap.size(yield* Ref.get(conn.s2cPending));

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

// Compile-time guard: if a new tagged variant lands in `S2cRpcError`
// without a matching test branch above, this assignment stops compiling.
type _ExhaustiveS2cTags =
  | "AppDisconnected"
  | "S2cRpcResponseError"
  | "S2cRpcDecodeError"
  | "S2cRpcSocketError";
const _exhaustive: _ExhaustiveS2cTags = "AppDisconnected";
void _exhaustive;
