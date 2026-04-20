/**
 * Tests for `ws-client.ts` — now running against a real in-process
 * `@effect/platform` WebSocket server instead of a `vi.mock("ws")` fake.
 *
 * Setup: each test spins up a fresh `NodeSocketServer.makeWebSocket` bound to
 * `127.0.0.1:0` (OS-assigned port). An explicit host is required — omitting
 * it binds `::` which `server.address()` returns verbatim, yielding a
 * non-dialable `ws://:::PORT` URL on Linux/macOS (gotcha §4.11).
 *
 * Coverage matches the §5 invariants + the typed-manifest + malformed-frame
 * cadence tests from the legacy suite. Reconnect-backoff uses real wall-clock
 * timing because the reconnect loop runs on the client's internal
 * `ManagedRuntime`, whose default Clock is out of reach of a test-fiber's
 * `TestClock` (see the `describe("reconnect backoff")` block for details).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { it as itEffect } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Scope,
  TestClock,
} from "effect";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Socket from "@effect/platform/Socket";
import { PROTOCOL_VERSION } from "@moltzap/protocol";

import { MoltZapWsClient, RPC_TIMEOUT_MS } from "./ws-client.js";
import { RpcTimeoutError } from "./runtime/errors.js";

// ── Test server helpers ────────────────────────────────────────────────

/**
 * Per-connection context exposed to a handler so tests can inspect and
 * manipulate the live server-side socket.
 */
interface TestServerConnection {
  /** Send a raw string frame to this client. */
  readonly send: (raw: string) => Effect.Effect<void>;
  /** Close this client's connection (CloseEvent code 1000 = clean). */
  readonly close: (code?: number) => Effect.Effect<void>;
  /** Every frame received from this client, in order. */
  readonly received: ReadonlyArray<string>;
}

/**
 * Handler invoked once per accepted server-side connection. Receives
 * (serverConn, rawFrame) per inbound frame. Return the raw string to respond,
 * `null` to drop, or throw a CloseEvent via `serverConn.close(code)`.
 */
type ServerHandler = (
  conn: TestServerConnection,
  raw: string,
) => Effect.Effect<void>;

interface TestServer {
  readonly url: string;
  /**
   * Accumulates every TestServerConnection ever accepted. Tests assert on
   * it to check e.g. no reconnect happened (length === 1).
   */
  readonly connections: ReadonlyArray<TestServerConnection>;
}

/**
 * Spin up an in-process `@effect/platform` WS server on `127.0.0.1:0`.
 * Caller owns the provided scope; when it closes, the server shuts down.
 */
const startTestServer = (
  handler: ServerHandler,
): Effect.Effect<TestServer, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const server = yield* NodeSocketServer.makeWebSocket({
      port: 0,
      host: "127.0.0.1",
    });
    const addr = server.address;
    if (addr._tag !== "TcpAddress") {
      return yield* Effect.die("expected TcpAddress");
    }
    const connections: TestServerConnection[] = [];

    yield* Effect.forkScoped(
      server
        .run((serverSock) =>
          Effect.gen(function* () {
            const write = yield* serverSock.writer;
            const receivedList: string[] = [];
            const conn: TestServerConnection = {
              send: (raw) => write(raw).pipe(Effect.ignore),
              close: (code = 1000) =>
                write(new Socket.CloseEvent(code, "test close")).pipe(
                  Effect.ignore,
                ),
              get received(): ReadonlyArray<string> {
                return receivedList;
              },
            };
            connections.push(conn);
            yield* serverSock.runRaw((data) =>
              Effect.gen(function* () {
                const raw =
                  typeof data === "string"
                    ? data
                    : new TextDecoder("utf-8").decode(data);
                receivedList.push(raw);
                yield* handler(conn, raw);
              }),
            );
          }),
        )
        .pipe(Effect.ignore),
    );

    return {
      url: `http://${addr.hostname}:${addr.port}`,
      get connections() {
        return connections;
      },
    };
  });

// ── Logger helper ──────────────────────────────────────────────────────

function makeLogger(): {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ── Client adapter helpers ─────────────────────────────────────────────

/**
 * Build a client, connect against the given URL, complete the auth/connect
 * handshake, and return the live client. The server handler auto-responds
 * to `auth/connect` with a canned HelloOk; subsequent frames route through
 * the outer `handler`.
 */
interface ClientHarness {
  readonly client: MoltZapWsClient;
  readonly serverConn: TestServerConnection;
  readonly logger: ReturnType<typeof makeLogger>;
  readonly onEventCalls: Array<unknown>;
  readonly onDisconnectCalls: Array<void>;
  readonly onReconnectCalls: Array<unknown>;
}

const connectP = (client: MoltZapWsClient): Promise<unknown> =>
  Effect.runPromise(
    client.connect().pipe(
      Effect.catchTag("RpcTimeoutError", (err) =>
        Effect.fail(new Error(`RPC timeout: ${err.method}`)),
      ),
      Effect.catchAll((err) => Effect.fail(new Error(err.message))),
    ),
  );

const sendRpcP = (
  client: MoltZapWsClient,
  method: string,
  params?: unknown,
): Promise<unknown> =>
  Effect.runPromise(
    client.sendRpc(method, params).pipe(
      Effect.catchTag("RpcTimeoutError", (err) =>
        Effect.fail(new Error(`RPC timeout: ${err.method}`)),
      ),
      Effect.catchAll((err) => Effect.fail(new Error(err.message))),
    ),
  );

const closeClient = (client: MoltZapWsClient): void => {
  Effect.runSync(client.close());
};

/**
 * Start a server whose handler auto-responds to `auth/connect` and forwards
 * everything else to the test's `handler`. Useful for tests that only care
 * about post-handshake behaviour.
 */
const startHandshakingServer = (
  handler: (
    conn: TestServerConnection,
    raw: string,
    frame: { id: string; method: string; params?: unknown },
  ) => Effect.Effect<void>,
): Effect.Effect<TestServer, unknown, Scope.Scope> =>
  startTestServer((conn, raw) =>
    Effect.gen(function* () {
      const frame = JSON.parse(raw) as {
        id: string;
        method: string;
        params?: unknown;
      };
      if (frame.method === "auth/connect") {
        yield* conn.send(
          JSON.stringify({
            jsonrpc: "2.0",
            type: "response",
            id: frame.id,
            result: { agentId: "agent-xyz", protocol: PROTOCOL_VERSION },
          }),
        );
        return;
      }
      yield* handler(conn, raw, frame);
    }),
  );

/**
 * Promise-returning wrapper that both runs a test Effect and keeps the scope
 * alive until the Effect completes. Tests that need a server scope should
 * use `withTestServer` rather than mutating a Scope manually.
 */
const withTestServer = async <A>(
  effect: Effect.Effect<A, unknown, Scope.Scope>,
): Promise<A> => {
  const scope = Effect.runSync(Scope.make());
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typed = Scope.extend(effect as any, scope) as Effect.Effect<A>;
    return await Effect.runPromise(typed);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

/**
 * Poll until `pred()` is true or `maxMs` elapses. The legacy test file used a
 * microtask-based loop; we keep that cadence to match the legacy behaviour
 * when synchronisation is driven by wall-clock timing in the test harness.
 */
async function waitFor(
  pred: () => boolean,
  { maxMs = 2000 }: { maxMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition not satisfied in time");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeClient(
  url: string,
  overrides?: {
    onEvent?: (evt: unknown) => void;
    onDisconnect?: () => void;
    onReconnect?: (hello: unknown) => void;
    logger?: ClientHarness["logger"];
  },
): MoltZapWsClient {
  return new MoltZapWsClient({
    serverUrl: url,
    agentKey: "test-key",
    onEvent: overrides?.onEvent ?? (() => {}),
    onDisconnect: overrides?.onDisconnect ?? (() => {}),
    onReconnect: overrides?.onReconnect ?? (() => {}),
    logger: overrides?.logger ?? makeLogger(),
  });
}

function parseSent(raw: string): {
  id: string;
  method: string;
  params?: unknown;
} {
  return JSON.parse(raw) as {
    id: string;
    method: string;
    params?: unknown;
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  // Nothing global to reset; each test owns its server scope.
});

afterEach(() => {
  // Nothing to clean up — test scopes close their own servers.
});

// ─────────────────────────────────────────────────────────────────────
// §5.1 — connect() must not hang on pre-open close/error
// ─────────────────────────────────────────────────────────────────────

describe("§5.1 connect() does not hang on pre-open failure", () => {
  it("rejects immediately when the server closes the connection before handshake", async () => {
    await withTestServer(
      Effect.gen(function* () {
        // Handler closes on the very first inbound frame — i.e. before the
        // client sees any auth/connect response.
        const server = yield* startTestServer((conn) =>
          conn.close(1000).pipe(Effect.ignore),
        );
        const client = makeClient(server.url);
        const t0 = Date.now();
        yield* Effect.promise(() =>
          expect(connectP(client)).rejects.toThrow(/WebSocket not connected/),
        );
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeLessThan(3000);
        closeClient(client);
      }),
    );
  });

  it("rejects when the server refuses the connection (well within RPC timeout)", async () => {
    // Point the client at a port that's not accepting connections. The
    // `ws` lib emits 'error' on TCP connect failure which maps to
    // `SocketGenericError{reason: "Open"}`. Our reader fiber's `onExit`
    // catches and fails the handshake deferred → NotConnectedError.
    //
    // Observed: ECONNREFUSED fires in single-digit ms locally; give
    // generous CI headroom via the 15s assertion but keep test timeout at
    // 20s to avoid flakes on slow runners.
    const client = makeClient("http://127.0.0.1:1");
    const t0 = Date.now();
    try {
      await connectP(client);
      throw new Error("expected connect to reject");
    } catch (err) {
      expect((err as Error).message).toMatch(/WebSocket not connected/);
    }
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(15_000);
    closeClient(client);
  }, 20_000);

  it("resolves with HelloOk on the happy open → auth/connect path", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url);
        const hello = (yield* Effect.promise(() => connectP(client))) as {
          agentId: string;
        };
        expect(hello.agentId).toBe("agent-xyz");
        expect(client.helloOk).toEqual(hello);
        closeClient(client);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// §5.2 — pending RPCs fail fast on disconnect
// ─────────────────────────────────────────────────────────────────────

describe("§5.2 pending RPCs fail on disconnect", () => {
  it("rejects pending sendRpc calls when disconnect() is called", async () => {
    await withTestServer(
      Effect.gen(function* () {
        // Handler responds to auth/connect but drops everything else, so the
        // RPC stays pending until we trigger disconnect.
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url);
        yield* Effect.promise(() => connectP(client));

        const rpcP = sendRpcP(client, "messages/send", {
          conversationId: "c1",
          parts: [{ type: "text", text: "hi" }],
        });
        // Wait for the RPC frame to land on the server.
        yield* Effect.promise(() =>
          waitFor(() => server.connections[0]!.received.length >= 2),
        );

        // Trigger disconnect — the reader-fiber `onExit` path drains pendings
        // with NotConnectedError.
        yield* client.disconnect();

        yield* Effect.promise(() =>
          expect(rpcP).rejects.toThrow(/WebSocket not connected/),
        );
        closeClient(client);
      }),
    );
  });
});

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

describe("§5.3 sendRpc does NOT retry on timeout (TestClock)", () => {
  itEffect.scoped(
    "fails with RpcTimeoutError after virtual 30s, no retry frame",
    () =>
      Effect.gen(function* () {
        // Server answers auth/connect, then silently drops messages/send.
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url);

        // Handshake: not wrapped in Effect.sleep, so TestClock doesn't
        // interfere.
        yield* Effect.promise(() => connectP(client));

        const serverConn = server.connections[0]!;
        const beforeCount = serverConn.received.length;

        const rpcFiber = yield* Effect.fork(
          client.sendRpc("messages/send", {
            conversationId: "c1",
            parts: [{ type: "text", text: "payload" }],
          }),
        );

        // Wait for the frame to land on the server using real-time polling.
        // `Effect.async` sidesteps TestClock: the callback fires when our
        // setTimeout triggers on the real event loop.
        yield* Effect.async<void>((resume) => {
          const deadlineMs = Date.now() + 2000;
          const tick = (): void => {
            if (serverConn.received.length > beforeCount) {
              resume(Effect.void);
              return;
            }
            if (Date.now() > deadlineMs) {
              resume(Effect.void);
              return;
            }
            setTimeout(tick, 5);
          };
          setTimeout(tick, 5);
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
              expect(err.method).toBe("messages/send");
              expect(err.timeoutMs).toBe(RPC_TIMEOUT_MS);
            }
          }
        }

        // No retry frame may have been enqueued — timeout is terminal. Bounce
        // once through the real event loop for any stragglers.
        yield* Effect.async<void>((resume) => {
          setTimeout(() => resume(Effect.void), 50);
        });
        expect(serverConn.received.length).toBe(beforeCount + 1);

        yield* client.close();
      }),
  );
});

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

describe("reconnect backoff", () => {
  it("reconnects with exponential-jittered backoff after unsolicited server close", async () => {
    await withTestServer(
      Effect.gen(function* () {
        let authResponsesSent = 0;
        let reconnectHello: unknown = null;
        const server = yield* startTestServer((conn, raw) =>
          Effect.gen(function* () {
            const frame = JSON.parse(raw) as { id: string; method: string };
            if (frame.method === "auth/connect") {
              authResponsesSent++;
              yield* conn.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  type: "response",
                  id: frame.id,
                  result: { agentId: "agent-1" },
                }),
              );
            }
          }),
        );
        const client = makeClient(server.url, {
          onReconnect: (hello) => {
            reconnectHello = hello;
          },
        });

        yield* Effect.promise(() => connectP(client));
        expect(authResponsesSent).toBe(1);
        expect(server.connections.length).toBe(1);

        // Kill the server-side connection. The client's reader sees a close,
        // fails pendings, invokes onDisconnect, and schedules a reconnect
        // via `Effect.sleep` + `Schedule.jittered`.
        yield* server.connections[0]!.close(1000);

        yield* Effect.promise(() =>
          waitFor(
            () => server.connections.length >= 2 && authResponsesSent >= 2,
            { maxMs: 2500 },
          ),
        );
        expect(server.connections.length).toBeGreaterThanOrEqual(2);
        expect(authResponsesSent).toBeGreaterThanOrEqual(2);

        yield* Effect.promise(() =>
          waitFor(() => reconnectHello !== null, { maxMs: 500 }),
        );
        expect((reconnectHello as { agentId: string }).agentId).toBe("agent-1");

        closeClient(client);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// §5.4 — malformed inbound frames logged + ignored, not crashing
// ─────────────────────────────────────────────────────────────────────

describe("§5.4 malformed frames are logged but do not affect pending RPCs", () => {
  it("ignores non-JSON frames while a pending RPC is outstanding, then resolves on the real response", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const logger = makeLogger();
        // Server auto-handshakes. On `conversations/list`, injects a few
        // malformed inbound frames, then the real response.
        const server = yield* startHandshakingServer((conn, _raw, frame) =>
          Effect.gen(function* () {
            if (frame.method !== "conversations/list") return;
            // Inject: non-JSON, then missing-id response, then unknown type.
            yield* conn.send("not json at all");
            yield* conn.send(JSON.stringify({ type: "response" }));
            yield* conn.send(JSON.stringify({ type: "unknown", id: frame.id }));
            // Real well-formed response.
            yield* conn.send(
              JSON.stringify({
                jsonrpc: "2.0",
                type: "response",
                id: frame.id,
                result: { conversations: [] },
              }),
            );
          }),
        );
        const client = makeClient(server.url, { logger });
        yield* Effect.promise(() => connectP(client));

        const result = (yield* Effect.promise(() =>
          sendRpcP(client, "conversations/list", {}),
        )) as { conversations: unknown[] };
        expect(result.conversations).toEqual([]);
        // Logger saw at least one malformed-frame warning.
        expect(logger.warn).toHaveBeenCalled();

        closeClient(client);
      }),
    );
  });

  it("accepts a padded chunk that contains both an event and the response", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const logger = makeLogger();
        const events: unknown[] = [];
        const server = yield* startHandshakingServer((conn, _raw, frame) =>
          Effect.gen(function* () {
            if (frame.method !== "conversations/list") return;
            yield* conn.send(
              JSON.stringify({
                jsonrpc: "2.0",
                type: "event",
                event: "messages/received",
                data: { message: { id: "m-1", conversationId: "c-1" } },
              }) +
                "\u0000" +
                JSON.stringify({
                  jsonrpc: "2.0",
                  type: "response",
                  id: frame.id,
                  result: { conversations: [] },
                }),
            );
          }),
        );
        const client = makeClient(server.url, {
          logger,
          onEvent: (event) => events.push(event),
        });
        yield* Effect.promise(() => connectP(client));

        const result = (yield* Effect.promise(() =>
          sendRpcP(client, "conversations/list", {}),
        )) as { conversations: unknown[] };

        expect(result.conversations).toEqual([]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ event: "messages/received" });
        expect(logger.warn).not.toHaveBeenCalled();

        closeClient(client);
      }),
    );
  });

  it("routes a well-formed event frame to onEvent", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const events: unknown[] = [];
        const server = yield* startHandshakingServer((conn) =>
          conn.send(
            JSON.stringify({
              jsonrpc: "2.0",
              type: "event",
              event: "message.received",
              data: { message: { id: "m-1", conversationId: "c-1" } },
            }),
          ),
        );
        const client = makeClient(server.url, {
          onEvent: (e) => events.push(e),
        });
        yield* Effect.promise(() => connectP(client));

        // Fire-and-forget: the server responds with an out-of-band event
        // rather than an RPC response, so the noop Deferred never resolves.
        // Awaiting it would wedge the test for the full RPC_TIMEOUT_MS.
        void sendRpcP(client, "noop", {}).catch(() => {});
        yield* Effect.promise(() =>
          waitFor(() => events.length > 0, { maxMs: 2000 }),
        );
        expect(events[0]).toMatchObject({
          type: "event",
          event: "message.received",
        });

        closeClient(client);
      }),
    );
  });

  it("does NOT route an event frame missing the event name field", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const events: unknown[] = [];
        const logger = makeLogger();
        // Send a malformed event on the first post-handshake frame.
        const server = yield* startHandshakingServer((conn) =>
          conn.send(JSON.stringify({ type: "event", data: {} })),
        );
        const client = makeClient(server.url, {
          onEvent: (e) => events.push(e),
          logger,
        });
        yield* Effect.promise(() => connectP(client));

        // Fire-and-forget: see the well-formed-event test above for rationale.
        void sendRpcP(client, "noop", {}).catch(() => {});
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 50)));
        expect(events).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalled();

        closeClient(client);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Malformed-frame log cadence
// ─────────────────────────────────────────────────────────────────────

describe("malformed-frame log cadence (MALFORMED_LOG_EVERY)", () => {
  it("logs at frames #1, #50, #100 and suppresses everything in between", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const logger = makeLogger();
        // Server auto-handshakes. On ANY post-handshake frame, fires 101
        // malformed frames back at the client.
        const server = yield* startHandshakingServer((conn) =>
          Effect.gen(function* () {
            for (let i = 0; i < 101; i++) {
              yield* conn.send("definitely not json " + i);
            }
          }),
        );
        const client = makeClient(server.url, { logger });
        yield* Effect.promise(() => connectP(client));

        logger.warn.mockClear();

        // Fire-and-forget: server responds with 101 malformed frames, no
        // actual RPC response, so awaiting the noop would wedge the test.
        void sendRpcP(client, "noop", {}).catch(() => {});

        // Wait for the malformed frames to flush through the reader fiber.
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 300)));

        expect(logger.warn).toHaveBeenCalledTimes(3);
        const warnMessages = logger.warn.mock.calls.map(
          (c: unknown[]) => c[0] as string,
        );
        expect(warnMessages[0]).toMatch(/^Malformed frame \(#1\):/);
        expect(warnMessages[1]).toMatch(/^Malformed frame \(#50\):/);
        expect(warnMessages[2]).toMatch(/^Malformed frame \(#100\):/);

        closeClient(client);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// close() vs pending-RPC interleave
// ─────────────────────────────────────────────────────────────────────

describe("close() interleaved with a pending RPC", () => {
  it("rejects the pending RPC with NotConnectedError before any timeout", async () => {
    await withTestServer(
      Effect.gen(function* () {
        // Server handshakes then drops everything.
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url);
        yield* Effect.promise(() => connectP(client));

        const rpcP = sendRpcP(client, "conversations/list", {});
        yield* Effect.promise(() =>
          waitFor(() => server.connections[0]!.received.length >= 2),
        );

        const beforeMs = Date.now();
        closeClient(client);
        yield* Effect.promise(() =>
          expect(rpcP).rejects.toThrow(/WebSocket not connected/),
        );
        expect(Date.now() - beforeMs).toBeLessThan(1000);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// ws.on("error") → close propagation
// ─────────────────────────────────────────────────────────────────────

describe("socket error after connect", () => {
  it("pending RPCs reject with NotConnectedError after the server closes", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const logger = makeLogger();
        // Handshakes, then on any follow-up RPC, closes abruptly (code 1011).
        const server = yield* startHandshakingServer((conn) =>
          conn.close(1011),
        );
        const client = makeClient(server.url, { logger });
        yield* Effect.promise(() => connectP(client));

        const rpcP = sendRpcP(client, "conversations/list", {});
        yield* Effect.promise(() =>
          expect(rpcP).rejects.toThrow(/WebSocket not connected/),
        );
        // Logger captured the WebSocket error (warn level).
        expect(logger.warn).toHaveBeenCalled();

        closeClient(client);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Typed-manifest sendRpc overload
// ─────────────────────────────────────────────────────────────────────

describe("sendRpc(RpcDefinition, params) — typed manifest overload", () => {
  it("uses definition.name as the wire-level method string", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const { AgentsLookupByName } = yield* Effect.promise(
          () => import("@moltzap/protocol"),
        );
        // Echo the method name + params back as the result so the test can
        // verify both the wire-level method and the forwarded params.
        const server = yield* startHandshakingServer((conn, _raw, frame) =>
          conn.send(
            JSON.stringify({
              jsonrpc: "2.0",
              type: "response",
              id: frame.id,
              result: {
                echoedMethod: frame.method,
                echoedParams: frame.params,
                agents: [],
              },
            }),
          ),
        );
        const client = makeClient(server.url);
        yield* Effect.promise(() => connectP(client));

        const result = (yield* Effect.promise(() =>
          Effect.runPromise(
            client.sendRpc(AgentsLookupByName, { names: ["alice"] }),
          ),
        )) as {
          echoedMethod: string;
          echoedParams: { names: string[] };
          agents: unknown[];
        };
        expect(result.echoedMethod).toBe("agents/lookupByName");
        expect(result.echoedParams).toEqual({ names: ["alice"] });

        closeClient(client);
      }),
    );
  });

  it("preserves the legacy string overload for back-compat", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const server = yield* startHandshakingServer((conn, _raw, frame) =>
          conn.send(
            JSON.stringify({
              jsonrpc: "2.0",
              type: "response",
              id: frame.id,
              result: { echoedMethod: frame.method, agents: [] },
            }),
          ),
        );
        const client = makeClient(server.url);
        yield* Effect.promise(() => connectP(client));

        const result = (yield* Effect.promise(() =>
          sendRpcP(client, "agents/lookupByName", { names: ["bob"] }),
        )) as { echoedMethod: string; agents: unknown[] };
        expect(result.echoedMethod).toBe("agents/lookupByName");

        closeClient(client);
      }),
    );
  });
});
