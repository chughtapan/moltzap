/**
 * Tests for `app-client.ts` against a real in-process `@effect/platform` WebSocket server.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";

import { MessagesAuthorize, TaskCreate } from "@moltzap/protocol";
import {
  AgentsLookupByName,
  TaskList,
  DispatchAuthorize,
  Duration,
  Fiber,
  ForbiddenError,
  MessageReceivedNotificationDefinition,
  MessagesSend,
  RpcTimeoutError,
  TestClock,
  closeClient,
  closeWaitSocketOutput,
  connectClient,
  connectClientForServer,
  dispatchRequestParams,
  effectTest,
  expectEffectFailure,
  findClosedLocalPort,
  findResponseRaw,
  grantDispatchAuthorizeHandlers,
  makeClient,
  messageReceivedFrame,
  realSleep,
  sendMalformedFrameBurst,
  sendMalformedFramesAndResponse,
  sendPaddedNotificationAndResponse,
  sendRpcEffect,
  setRef,
  scopedEffectTest,
  startAgentsLookupByNameServer,
  startDispatchAuthorizeServer,
  startHandshakingServer,
  startReconnectServer,
  startTestServer,
  validateResponseFrame,
  waitFor,
  waitForErrorResponse,
  waitForResponseRaw,
  withTestServer,
  CLIENT_DRAIN_COUNT,
  CLOSE_INFO_WAIT_MS,
  CLOSE_PROPAGATION_TIMEOUT_MS,
  CONNECT_FAILURE_MAX_MS,
  DOMAIN_REJECTED_MESSAGE,
  DOMAIN_REJECTED_REASON,
  GRANT_DECISION,
  HANDLER_REJECTION_CODE,
  JSON_RPC_VERSION,
  LOCALHOST_HOST,
  MALFORMED_FRAME_FLUSH_MS,
  NORMAL_CLOSE_CODE,
  NORMAL_CLOSE_REASON,
  POST_TIMEOUT_SETTLE_MS,
  REALTIME_POLL_TIMEOUT_MS,
  RECONNECT_AGENT_ID,
  REFUSED_CONNECT_MAX_MS,
  REFUSED_CONNECT_TEST_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  SESSION_A,
  SESSION_B,
  SERVER_ERROR_CLOSE_CODE,
  SERVER_ERROR_REASON,
  SERVER_ERROR_REQUEST_ID,
  SERVER_TEST_REQUEST_ID,
  STALE_PORT_TEST_TIMEOUT_MS,
  TEST_AGENT_ID,
  TEST_CONVERSATION_ID,
  TEST_TASK_ID,
  type CloseInfo,
  type MutableRef,
  type RequestFrame,
} from "./app-client-test-support.js";
import { shouldLogMalformedFrame } from "./runtime/reconnect.js";

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  // Nothing global to reset; each test owns its server scope.
});

afterEach(() => {
  // Nothing to clean up — test scopes close their own servers.
});

it("encodes the notification fixture with the protocol method name", () => {
  expect(messageReceivedFrame().method).toBe(
    MessageReceivedNotificationDefinition.name,
  );
});

// ─────────────────────────────────────────────────────────────────────
// §5.1 — connect() must not hang on pre-open close/error
// ─────────────────────────────────────────────────────────────────────

effectTest(
  "rejects immediately when the server closes the connection before handshake",
  () =>
    withTestServer(
      Effect.gen(function* () {
        // Handler closes on the very first inbound frame — i.e. before the
        // client sees any network/connect response.
        const server = yield* startTestServer((conn) =>
          conn.close(NORMAL_CLOSE_CODE).pipe(Effect.ignore),
        );
        const client = makeClient(server.url);
        const t0 = Date.now();
        yield* expectEffectFailure(
          connectClient(client),
          /WebSocket not connected/,
        );
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeLessThan(CONNECT_FAILURE_MAX_MS);
        yield* closeClient(client);
      }),
    ),
);

effectTest(
  "rejects when the server refuses the connection (well within RPC timeout)",
  () =>
    Effect.gen(function* () {
      // Point the client at a port that's not accepting connections. The
      // `ws` lib emits 'error' on TCP connect failure which maps to
      // `SocketGenericError{reason: "Open"}`. Our reader fiber's `onExit`
      // catches and fails the handshake deferred -> NotConnectedError.
      //
      // Observed: ECONNREFUSED fires in single-digit ms locally; give
      // generous CI headroom via the 15s assertion but keep test timeout at
      // 20s to avoid flakes on slow runners.
      const refusedPort = yield* findClosedLocalPort();
      const client = makeClient(`http://${LOCALHOST_HOST}:${refusedPort}`);
      const t0 = Date.now();
      yield* expectEffectFailure(
        connectClient(client),
        /WebSocket not connected/,
      );
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(REFUSED_CONNECT_MAX_MS);
      yield* closeClient(client);
    }),
  REFUSED_CONNECT_TEST_TIMEOUT_MS,
);

effectTest(
  "resolves with HelloOk on the happy open -> network/connect path",
  () =>
    withTestServer(
      Effect.gen(function* () {
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url);
        const hello = (yield* connectClient(client)) as {
          agentId: string;
        };
        expect(hello.agentId).toBe(TEST_AGENT_ID);
        expect(client.helloOk).toEqual(hello);
        yield* closeClient(client);
      }),
    ),
);

// ─────────────────────────────────────────────────────────────────────
// §5.2 — pending RPCs fail fast on disconnect
// ─────────────────────────────────────────────────────────────────────

effectTest("rejects pending sendRpc calls when disconnect() is called", () =>
  withTestServer(
    Effect.gen(function* () {
      // Handler responds to network/connect but drops everything else, so the
      // RPC stays pending until we trigger disconnect.
      const server = yield* startHandshakingServer(() => Effect.void);
      const client = makeClient(server.url);
      yield* connectClient(client);

      const rpcFiber = yield* Effect.fork(
        sendRpcEffect(client, MessagesSend, {
          taskId: TEST_TASK_ID,
          conversationId: TEST_CONVERSATION_ID,
          parts: [{ type: "text", text: "hi" }],
        }),
      );
      // Wait for the RPC frame to land on the server.
      yield* waitFor(() => server.connections[0]!.received.length >= 2);

      // Trigger disconnect — the reader-fiber `onExit` path drains pendings
      // with NotConnectedError.
      yield* client.disconnect();

      yield* expectEffectFailure(
        Fiber.join(rpcFiber),
        /WebSocket not connected/,
      );
      yield* closeClient(client);
    }),
  ),
);

// ─────────────────────────────────────────────────────────────────────
// §5.3 — no automatic retry on timeout (TestClock-driven)
// ─────────────────────────────────────────────────────────────────────
//
// `sendRpcEffect` wraps `Deferred.await` with `Effect.timeoutFail`, which
// schedules against the Effect Clock. Under `@effect/vitest`'s `it.effect`
// that Clock is a TestClock, so `TestClock.adjust(Duration.millis(30_000))`
// advances virtual time and fires the timeout synchronously.
//
// Layering caveat: `Effect.sleep` (TestClock) and real DOM WebSocket events
// (real timers) live on different clocks. The handshake runs without any
// `Effect.sleep`, so it completes against wall-clock. We poll server-side
// frame arrival via real setTimeout (sidesteps TestClock) so the test can
// wait for the RPC frame to land before advancing virtual time.

scopedEffectTest(
  "fails with RpcTimeoutError after virtual 30s, no retry frame",
  () =>
    withTestServer(
      Effect.gen(function* () {
        // Server answers network/connect, then silently drops messages/send.
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url);

        // Handshake: not wrapped in Effect.sleep, so TestClock doesn't
        // interfere.
        yield* connectClient(client);

        const serverConn = server.connections[0]!;
        const beforeCount = serverConn.received.length;

        const rpcFiber = yield* Effect.fork(
          client.sendRpc(MessagesSend, {
            taskId: TEST_TASK_ID,
            conversationId: TEST_CONVERSATION_ID,
            parts: [{ type: "text", text: "payload" }],
          }),
        );

        yield* waitFor(() => serverConn.received.length > beforeCount, {
          maxMs: REALTIME_POLL_TIMEOUT_MS,
        });
        expect(serverConn.received.length).toBe(beforeCount + 1);

        // Virtual time: advance past RPC_TIMEOUT_MS → timeoutFail fires.
        yield* TestClock.adjust(Duration.millis(RPC_TIMEOUT_MS));

        const exit = yield* Fiber.await(rpcFiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          // Cause.failureOption narrows the cause to its typed error without
          // touching `_tag` manually. instanceof pins the class nominally
          // in case a defect slipped through with a matching shape.
          const failed = Cause.failureOption(exit.cause);
          expect(Option.isSome(failed)).toBe(true);
          if (Option.isSome(failed)) {
            const err = failed.value;
            expect(err).toBeInstanceOf(RpcTimeoutError);
            if (err instanceof RpcTimeoutError) {
              expect(err.method).toBe(MessagesSend.name);
              expect(err.timeoutMs).toBe(RPC_TIMEOUT_MS);
            }
          }
        }

        // No retry frame may have been enqueued — timeout is terminal. Bounce
        // once through the real event loop for any stragglers.
        yield* realSleep(POST_TIMEOUT_SETTLE_MS);
        expect(serverConn.received.length).toBe(beforeCount + 1);

        yield* client.close();
      }),
    ),
);

// ─────────────────────────────────────────────────────────────────────
// Reconnect backoff — real wall-clock
// ─────────────────────────────────────────────────────────────────────
//
// The reconnect loop is forked on the client's internal `ManagedRuntime`
// (created in the constructor to provide `NodeSocket.layerWebSocketConstructor`
// without bubbling the requirement to callers). That runtime has its own
// default Clock, so `TestClock.adjust` from a test fiber doesn't release
// `Effect.sleep`s scheduled inside it. We assert on real wall-clock timing
// instead; the jittered base delay is [0, 1s] so 2.5s is a safe ceiling.

effectTest(
  "reconnects with exponential-jittered backoff after unsolicited server close",
  () =>
    withTestServer(
      Effect.gen(function* () {
        const authResponsesSent: MutableRef<number> = { current: 0 };
        const reconnectHello: MutableRef<unknown | null> = { current: null };
        const server = yield* startReconnectServer(authResponsesSent);
        const client = makeClient(server.url, {
          onReconnect: setRef(reconnectHello),
        });

        yield* connectClient(client);
        expect(authResponsesSent.current).toBe(1);
        expect(server.connections.length).toBe(1);

        // Kill the server-side connection. The client's reader sees a close,
        // fails pendings, invokes onDisconnect, and schedules a reconnect
        // via `Effect.sleep` + `Schedule.jittered`.
        yield* server.connections[0]!.close(NORMAL_CLOSE_CODE);

        yield* waitFor(
          () =>
            server.connections.length >= 2 && authResponsesSent.current >= 2,
          { maxMs: 2500 },
        );
        expect(server.connections.length).toBeGreaterThanOrEqual(2);
        expect(authResponsesSent.current).toBeGreaterThanOrEqual(2);

        yield* waitFor(() => reconnectHello.current !== null, { maxMs: 500 });
        expect((reconnectHello.current as { agentId: string }).agentId).toBe(
          RECONNECT_AGENT_ID,
        );

        yield* closeClient(client);
      }),
    ),
);

// ─────────────────────────────────────────────────────────────────────
// §5.4 — malformed inbound frames logged + ignored, not crashing
// ─────────────────────────────────────────────────────────────────────

effectTest(
  "ignores non-JSON frames while a pending RPC is outstanding, then resolves on the real response",
  () =>
    withTestServer(
      Effect.gen(function* () {
        // Server auto-handshakes. On `conversations/list`, injects a few
        // malformed inbound frames, then the real response.
        const server = yield* startHandshakingServer(
          sendMalformedFramesAndResponse,
        );
        const client = makeClient(server.url);
        yield* connectClient(client);

        const result = (yield* sendRpcEffect(client, TaskList, {})) as {
          tasks: unknown[];
        };
        expect(result.tasks).toEqual([]);
        yield* closeClient(client);
      }),
    ),
);

effectTest(
  "logs a combined notification and response text frame as malformed",
  () =>
    withTestServer(
      Effect.gen(function* () {
        const events: unknown[] = [];
        const server = yield* startHandshakingServer(
          sendPaddedNotificationAndResponse,
        );
        const client = makeClient(server.url, {
          onNotification: (event) => events.push(event),
        });
        yield* connectClient(client);

        const rpcFiber = yield* Effect.fork(
          sendRpcEffect(client, TaskList, {}).pipe(Effect.ignore),
        );
        yield* realSleep(POST_TIMEOUT_SETTLE_MS);

        expect(events).toHaveLength(0);

        yield* Fiber.interrupt(rpcFiber);
        yield* closeClient(client);
      }),
    ),
);

effectTest("routes a well-formed notification frame to onNotification", () =>
  withTestServer(
    Effect.gen(function* () {
      const events: unknown[] = [];
      const server = yield* startHandshakingServer((conn) =>
        conn.send(JSON.stringify(messageReceivedFrame())),
      );
      const client = makeClient(server.url, {
        onNotification: (e) => events.push(e),
      });
      yield* connectClient(client);

      // Fire-and-forget: the server responds with an out-of-band notification
      // rather than an RPC response, so the noop Deferred never resolves.
      // Awaiting it would wedge the test for the full RPC_TIMEOUT_MS.
      const rpcFiber = yield* Effect.fork(
        sendRpcEffect(client, TaskList, {}).pipe(Effect.ignore),
      );
      yield* waitFor(() => events.length > 0, {
        maxMs: CLOSE_INFO_WAIT_MS,
      });
      expect(events[0]).toMatchObject({
        method: MessageReceivedNotificationDefinition.name,
      });

      yield* Fiber.interrupt(rpcFiber);
      yield* closeClient(client);
    }),
  ),
);

effectTest("does NOT route a notification frame missing the method field", () =>
  withTestServer(
    Effect.gen(function* () {
      const events: unknown[] = [];
      // Send a malformed notification on the first post-handshake frame.
      const server = yield* startHandshakingServer((conn) =>
        conn.send(JSON.stringify({ jsonrpc: JSON_RPC_VERSION, params: {} })),
      );
      const client = makeClient(server.url, {
        onNotification: (e) => events.push(e),
      });
      yield* connectClient(client);

      // Fire-and-forget: see the well-formed-event test above for rationale.
      const rpcFiber = yield* Effect.fork(
        sendRpcEffect(client, TaskList, {}).pipe(Effect.ignore),
      );
      yield* Effect.sleep(Duration.millis(POST_TIMEOUT_SETTLE_MS));
      expect(events).toHaveLength(0);

      yield* Fiber.interrupt(rpcFiber);
      yield* closeClient(client);
    }),
  ),
);

// ─────────────────────────────────────────────────────────────────────
// Malformed-frame log cadence
// ─────────────────────────────────────────────────────────────────────

effectTest(
  "logs at frames #1, #50, #100 and suppresses everything in between",
  () =>
    withTestServer(
      Effect.gen(function* () {
        // Server auto-handshakes. On ANY post-handshake frame, fires 101
        // malformed frames back at the client.
        const server = yield* startHandshakingServer(sendMalformedFrameBurst);
        const client = makeClient(server.url);
        yield* connectClient(client);

        // Fire-and-forget: server responds with 101 malformed frames, no
        // actual RPC response, so awaiting the noop would wedge the test.
        const rpcFiber = yield* Effect.fork(
          sendRpcEffect(client, TaskList, {}).pipe(Effect.ignore),
        );

        // Wait for the malformed frames to flush through the reader fiber.
        yield* Effect.sleep(Duration.millis(MALFORMED_FRAME_FLUSH_MS));

        const loggedFrameNumbers = Array.from(
          { length: 101 },
          (_, index) => index + 1,
        ).filter(shouldLogMalformedFrame);
        expect(loggedFrameNumbers).toEqual([1, 50, 100]);

        yield* Fiber.interrupt(rpcFiber);
        yield* closeClient(client);
      }),
    ),
);

// ─────────────────────────────────────────────────────────────────────
// close() vs pending-RPC interleave
// ─────────────────────────────────────────────────────────────────────

effectTest(
  "rejects the pending RPC with NotConnectedError before any timeout",
  () =>
    withTestServer(
      Effect.gen(function* () {
        // Server handshakes then drops everything.
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url);
        yield* connectClient(client);

        const rpcFiber = yield* Effect.fork(
          sendRpcEffect(client, TaskList, {}),
        );
        yield* waitFor(() => server.connections[0]!.received.length >= 2);

        const beforeMs = Date.now();
        yield* closeClient(client);
        yield* expectEffectFailure(
          Fiber.join(rpcFiber),
          /WebSocket not connected/,
        );
        expect(Date.now() - beforeMs).toBeLessThan(
          CLOSE_PROPAGATION_TIMEOUT_MS,
        );
      }),
    ),
);

// ─────────────────────────────────────────────────────────────────────
// ws.on("error") → close propagation
// ─────────────────────────────────────────────────────────────────────

effectTest(
  "pending RPCs reject with NotConnectedError after the server closes",
  () =>
    withTestServer(
      Effect.gen(function* () {
        // Handshakes, then on any follow-up RPC, closes abruptly (code 1011).
        const server = yield* startHandshakingServer((conn) =>
          conn.close(SERVER_ERROR_CLOSE_CODE),
        );
        const client = makeClient(server.url);
        yield* connectClient(client);

        yield* expectEffectFailure(
          sendRpcEffect(client, TaskList, {}),
          /WebSocket not connected/,
        );
        yield* closeClient(client);
      }),
    ),
);

// ─────────────────────────────────────────────────────────────────────
// Typed-manifest sendRpc overload
// ─────────────────────────────────────────────────────────────────────

effectTest("uses definition.name as the wire-level method string", () =>
  withTestServer(
    Effect.gen(function* () {
      const captured: MutableRef<RequestFrame | null> = { current: null };
      const server = yield* startAgentsLookupByNameServer(captured);
      const client = makeClient(server.url);
      yield* connectClient(client);

      const result = yield* client.sendRpc(AgentsLookupByName, {
        names: ["alice"],
      });
      expect(result.agents).toEqual([]);
      expect(captured.current?.method).toBe(AgentsLookupByName.name);
      expect(captured.current?.params).toEqual({ names: ["alice"] });

      yield* closeClient(client);
    }),
  ),
);

// ─────────────────────────────────────────────────────────────────────
// AC2 — graceful close drains ESTABLISHED sockets (socket-count evidence)
// ─────────────────────────────────────────────────────────────────────

effectTest(
  "10 clients close cleanly: no CLOSE_WAIT sockets on the server port",
  () =>
    withTestServer(
      Effect.gen(function* () {
        const server = yield* startHandshakingServer(() => Effect.void);
        const port = new URL(server.url).port;

        // Connect 10 clients concurrently.
        const clients = yield* Effect.all(
          Array.from({ length: CLIENT_DRAIN_COUNT }, () =>
            connectClientForServer(server.url),
          ),
          { concurrency: CLIENT_DRAIN_COUNT },
        );
        expect(server.connections.length).toBe(CLIENT_DRAIN_COUNT);

        // Close all 10 via the graceful Effect-based close().
        yield* Effect.all(
          clients.map((c) => c.close()),
          { concurrency: CLIENT_DRAIN_COUNT },
        );

        // Brief pause for TCP close handshake to complete.
        yield* Effect.sleep("150 millis");

        // Assert no CLOSE_WAIT connections remain on the server port.
        const ssOut = yield* closeWaitSocketOutput;
        const stale = ssOut
          .split("\n")
          .filter(
            (line) => line.includes(`:${port} `) || line.endsWith(`:${port}`),
          );
        expect(stale).toHaveLength(0);
      }),
    ),
  STALE_PORT_TEST_TIMEOUT_MS,
);

// ─────────────────────────────────────────────────────────────────────
// Spec #222 §5.4 (V7) — `onDisconnect` receives a typed `CloseInfo`
// ─────────────────────────────────────────────────────────────────────

// Two distinguishable closes through the live reader-fiber path:
//   1. Server-initiated 1000/"bye"   → CloseInfo{1000, NORMAL_CLOSE_REASON}
//      (`@effect/platform/Socket` treats 1000 as `Exit.Success` per
//      its default `closeCodeIsError`; `extractCloseInfo` synthesizes
//      the OQ-5 graceful default — the close-frame reason is dropped
//      because there's no `SocketCloseError` to round-trip.)
//   2. Server-initiated 1011/SERVER_ERROR_REASON → CloseInfo{1011, SERVER_ERROR_REASON}
//      (non-1000 codes raise `SocketCloseError`; the real code +
//      `closeReason` round-trip through.)
//
// The pre-deletion adapter hardcoded `{1000, "disconnect"}` regardless
// of the actual close. A V7 mutation that re-introduces the hardcode
// flips the second test's `code === 1011` assertion pass → fail,
// satisfying AC 5.4-4 (distinguishable payloads). The OQ-5
// default-fallback paths (HandshakeFailure / TransportFailure /
// Unknown → DEFAULT_ABNORMAL_CLOSE) are covered by the direct unit
// tests in `runtime/close-info.test.ts`, where synthetic `Exit`
// values exercise each branch without a real transport.
effectTest(
  "synthesizes the graceful default when the transport treats 1000 as Exit.Success",
  () =>
    withTestServer(
      Effect.gen(function* () {
        const closes: CloseInfo[] = [];
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url, {
          onDisconnect: (close) => {
            closes.push(close);
          },
        });
        yield* connectClient(client);
        yield* server.connections[0]!.close(NORMAL_CLOSE_CODE, "bye");

        yield* waitFor(() => closes.length > 0, {
          maxMs: CLOSE_INFO_WAIT_MS,
        });
        yield* closeClient(client);

        expect(closes.length).toBeGreaterThanOrEqual(1);
        const first = closes[0]!;
        expect(first.code).toBe(NORMAL_CLOSE_CODE);
        expect(first.reason).toBe(NORMAL_CLOSE_REASON); // OQ-5 default, not "bye"
      }),
    ),
);

effectTest(
  "round-trips the server's close code + reason for a 1011 (server error) close",
  () =>
    withTestServer(
      Effect.gen(function* () {
        const closes: CloseInfo[] = [];
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url, {
          onDisconnect: (close) => {
            closes.push(close);
          },
        });
        yield* connectClient(client);
        yield* server.connections[0]!.close(
          SERVER_ERROR_CLOSE_CODE,
          SERVER_ERROR_REASON,
        );

        yield* waitFor(() => closes.length > 0, {
          maxMs: CLOSE_INFO_WAIT_MS,
        });
        yield* closeClient(client);

        expect(closes.length).toBeGreaterThanOrEqual(1);
        const first = closes[0]!;
        // Distinguishable from the 1000 test above (AC 5.4-4):
        // a hardcoded `{1000, "disconnect"}` would fail this assertion.
        expect(first.code).toBe(SERVER_ERROR_CLOSE_CODE);
        expect(first.reason).toBe(SERVER_ERROR_REASON);
      }),
    ),
);

// ─────────────────────────────────────────────────────────────────────
// Phase 1.0 (B.1) gating tests — client-side server-initiated RPC
// (Spec F #617 typed-dispatcher app-callback handler table + dispatcher
// fiber + appCallback response write-back)
// ─────────────────────────────────────────────────────────────────────

effectTest(
  "dispatches an inbound appCallback request to the registered handler and writes the response back",
  () =>
    withTestServer(
      Effect.gen(function* () {
        // Server: auto-handshake; immediately AFTER replying to
        // network/connect, send an appCallback request to the client; capture every
        // subsequent inbound frame the client writes back. We're testing
        // the client's dispatcher fiber + handler registry + response
        // encoding.
        const server = yield* startDispatchAuthorizeServer(
          SERVER_TEST_REQUEST_ID,
          dispatchRequestParams(SESSION_A),
        );
        // Spec F: pass the app-callback handler table at construction
        // so the typed dispatcher sees it on the very first inbound
        // task-callback request. The handler captures the `taskId`
        // it was invoked with so the assertion below can verify the
        // request reached the right descriptor's handler.
        const observedTaskId: MutableRef<string | null> = { current: null };
        const client = makeClient(server.url, {
          handlers: grantDispatchAuthorizeHandlers(observedTaskId),
        });
        yield* connectClient(client);

        // Wait for the response frame the dispatcher writes back. The
        // server records every inbound frame in `received` — the appCallback
        // response should appear after the client's network/connect.
        const responseRaw = yield* waitForResponseRaw(
          server,
          SERVER_TEST_REQUEST_ID,
        );

        const parsedResponse: unknown = JSON.parse(responseRaw!);
        expect(validateResponseFrame(parsedResponse)).toBe(true);
        if (!validateResponseFrame(parsedResponse)) return;
        expect(parsedResponse.id).toBe(SERVER_TEST_REQUEST_ID);
        expect("result" in parsedResponse).toBe(true);
        if (!("result" in parsedResponse)) return;
        const result = parsedResponse.result as {
          admission: { decision: string };
        };
        expect(result.admission.decision).toBe(GRANT_DECISION);
        expect(observedTaskId.current).toBe(SESSION_A);

        yield* closeClient(client);
      }),
    ),
);

// Spec F: app-callback handler-table fragment bound at construction.
// The dispatch/authorize handler unconditionally fails with a
// registered tagged error so the dispatcher encodes it onto the wire
// as an `error` reply.
const REGISTERED_ERROR_HANDLERS = {
  "dispatch/authorize": {
    definition: DispatchAuthorize,
    handle: () =>
      Effect.fail(
        new ForbiddenError({
          message: DOMAIN_REJECTED_MESSAGE,
          data: { reason: DOMAIN_REJECTED_REASON },
        }),
      ),
  },
  "messages/authorize": {
    definition: MessagesAuthorize,
    handle: () => Effect.fail(new ForbiddenError({ message: "vacuous deny" })),
  },
  "task/create": {
    definition: TaskCreate,
    handle: () =>
      Effect.succeed({
        verdict: { decision: "reject" as const, reason: "vacuous deny" },
      }),
  },
} as const;

effectTest(
  "encodes a registered handler error as a `response` frame with `error`",
  () =>
    withTestServer(
      Effect.gen(function* () {
        const server = yield* startDispatchAuthorizeServer(
          SERVER_ERROR_REQUEST_ID,
          dispatchRequestParams(SESSION_B),
        );
        const client = makeClient(server.url, {
          handlers: REGISTERED_ERROR_HANDLERS,
        });
        yield* connectClient(client);

        yield* waitForErrorResponse(server, SERVER_ERROR_REQUEST_ID);

        const found = findResponseRaw(server, SERVER_ERROR_REQUEST_ID);
        const parsed: unknown = JSON.parse(found!);
        expect(validateResponseFrame(parsed)).toBe(true);
        if (!validateResponseFrame(parsed)) return;
        expect("error" in parsed).toBe(true);
        if (!("error" in parsed)) return;
        expect(parsed.error.code).toBe(HANDLER_REJECTION_CODE);
        expect(parsed.error.message).toBe(DOMAIN_REJECTED_MESSAGE);
        expect((parsed.error.data as { reason: string }).reason).toBe(
          DOMAIN_REJECTED_REASON,
        );

        yield* closeClient(client);
      }),
    ),
);

// Note: Spec F (#617) makes the app-callback handler table immutable at
// construction. Duplicate-key binding is now a TypeScript compile-time
// error at the object-literal site (duplicate property name on the
// `handlers` literal). The previous runtime
// duplicate-registration rejection test has been retired alongside the
// runtime register API (D3 deletion); the type system carries the
// invariant.

// ─────────────────────────────────────────────────────────────────────
// Regression gate (review-295): runSync(client.close()) and
// runSync(client.disconnect()) must not throw AsyncFiberException after
// the appCallback queue + dispatcher were added. The appCallback machinery lives off the
// per-connect Scope (allocated inline + forked via runtime.runFork) so
// `Scope.close` stays sync; teardown of the queue and dispatcher fiber
// is dispatched via `runFork` from close()/disconnectSync().
//
// Failure mode this guards: `Effect.acquireRelease(Queue.dropping, Queue.shutdown)
// .pipe(Scope.extend(scope))` + `Effect.forkScoped` would have made the
// scope teardown async, breaking
// packages/openclaw-channel/src/__tests__/reconnection.integration.test.ts:14
// (`closeWs = (c) => Effect.runSync(c.close())`).
// ─────────────────────────────────────────────────────────────────────

effectTest("client.close() runs synchronously after a successful connect", () =>
  withTestServer(
    Effect.gen(function* () {
      const server = yield* startHandshakingServer(() => Effect.void);
      const client = makeClient(server.url);
      yield* connectClient(client);
      // Critical: this MUST be runSync, not runPromise. Throwing
      // AsyncFiberException here is the regression we're guarding.
      expect(() => Effect.runSync(client.close())).not.toThrow();
    }),
  ),
);

effectTest(
  "client.disconnect() runs synchronously after a successful connect",
  () =>
    withTestServer(
      Effect.gen(function* () {
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url);
        yield* connectClient(client);
        expect(() => Effect.runSync(client.disconnect())).not.toThrow();
        // Drain reconnect-fiber + runtime so vitest doesn't flag dangling work.
        yield* closeClient(client);
      }),
    ),
);
