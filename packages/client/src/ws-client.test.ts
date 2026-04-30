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
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { it as itEffect } from "@effect/vitest";
import {
  Cause,
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

import {
  MoltZapWsClient,
  RPC_TIMEOUT_MS,
  type CloseInfo,
} from "./ws-client.js";
import { RpcServerError, RpcTimeoutError } from "./runtime/errors.js";
import type { EventFrame } from "@moltzap/protocol";

// ── Test server helpers ────────────────────────────────────────────────

/**
 * Per-connection context exposed to a handler so tests can inspect and
 * manipulate the live server-side socket.
 */
interface TestServerConnection {
  /** Send a raw string frame to this client. */
  readonly send: (raw: string) => Effect.Effect<void>;
  /** Close this client's connection (CloseEvent code 1000 = clean). */
  readonly close: (code?: number, reason?: string) => Effect.Effect<void>;
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
              close: (code = 1000, reason = "test close") =>
                write(new Socket.CloseEvent(code, reason)).pipe(Effect.ignore),
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

const closeClient = (client: MoltZapWsClient): Effect.Effect<void, never> =>
  client.close();

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
            direction: "c2s",
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

/**
 * Build a `MoltZapWsClient`. Spec #222 OQ-4 deletion: `onEvent` is no
 * longer a constructor option; tests that previously stashed an
 * `onEvent` callback now register a `subscribe({}, …)` subscription
 * post-construction. The helper accepts the same `onEvent` callback as
 * a convenience and wires it through the new subscription registry,
 * keeping migration noise local to the helper.
 */
function makeClient(
  url: string,
  overrides?: {
    onEvent?: (evt: EventFrame) => void;
    onDisconnect?: (close: CloseInfo) => void;
    onReconnect?: (hello: unknown) => void;
    logger?: ClientHarness["logger"];
  },
): MoltZapWsClient {
  const client = new MoltZapWsClient({
    serverUrl: url,
    agentKey: "test-key",
    onDisconnect: overrides?.onDisconnect ?? ((_close) => {}),
    onReconnect: overrides?.onReconnect ?? (() => {}),
    logger: overrides?.logger ?? makeLogger(),
  });
  if (overrides?.onEvent !== undefined) {
    const cb = overrides.onEvent;
    Effect.runSync(
      client.subscribe({}, (frame) => Effect.sync(() => cb(frame))),
    );
  }
  return client;
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
        yield* closeClient(client);
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
    await Effect.runPromise(client.close());
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
        yield* closeClient(client);
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
        yield* closeClient(client);
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
                  direction: "c2s",
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

        yield* closeClient(client);
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
                direction: "c2s",
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

        yield* closeClient(client);
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
                  direction: "c2s",
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

        yield* closeClient(client);
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

        yield* closeClient(client);
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

        yield* closeClient(client);
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

        yield* closeClient(client);
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
        yield* closeClient(client);
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

        yield* closeClient(client);
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
              direction: "c2s",
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

        yield* closeClient(client);
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
              direction: "c2s",
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

        yield* closeClient(client);
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// AC2 — graceful close drains ESTABLISHED sockets (socket-count evidence)
// ─────────────────────────────────────────────────────────────────────

describe("graceful close drains ESTABLISHED sockets (AC2)", () => {
  it("10 clients close cleanly: no CLOSE_WAIT sockets on the server port", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const server = yield* startHandshakingServer(() => Effect.void);
        const port = new URL(server.url).port;

        // Connect 10 clients concurrently.
        const clients = yield* Effect.all(
          Array.from({ length: 10 }, () => {
            const c = makeClient(server.url);
            return Effect.promise(() => connectP(c)).pipe(Effect.map(() => c));
          }),
          { concurrency: "unbounded" },
        );
        expect(server.connections.length).toBe(10);

        // Close all 10 via the graceful Effect-based close().
        yield* Effect.all(
          clients.map((c) => c.close()),
          { concurrency: "unbounded" },
        );

        // Brief pause for TCP close handshake to complete.
        yield* Effect.sleep("150 millis");

        // Assert no CLOSE_WAIT connections remain on the server port.
        const ssOut = yield* Effect.sync(() =>
          execSync("ss -tn state CLOSE-WAIT 2>/dev/null || true", {
            encoding: "utf-8",
          }),
        );
        const stale = ssOut
          .split("\n")
          .filter(
            (line) => line.includes(`:${port} `) || line.endsWith(`:${port}`),
          );
        expect(stale).toHaveLength(0);
      }),
    );
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────
// Spec #222 §5.4 (V7) — `onDisconnect` receives a typed `CloseInfo`
// ─────────────────────────────────────────────────────────────────────

describe("spec #222 §5.4 — onDisconnect close metadata (V7)", () => {
  // Two distinguishable closes through the live reader-fiber path:
  //   1. Server-initiated 1000/"bye"   → CloseInfo{1000, "normal"}
  //      (`@effect/platform/Socket` treats 1000 as `Exit.Success` per
  //      its default `closeCodeIsError`; `extractCloseInfo` synthesizes
  //      the OQ-5 graceful default — the close-frame reason is dropped
  //      because there's no `SocketCloseError` to round-trip.)
  //   2. Server-initiated 1011/"boom" → CloseInfo{1011, "boom"}
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
  it("synthesizes the graceful default when the transport treats 1000 as Exit.Success", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const closes: CloseInfo[] = [];
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url, {
          onDisconnect: (close) => {
            closes.push(close);
          },
        });
        yield* Effect.promise(() => connectP(client));
        yield* server.connections[0]!.close(1000, "bye");

        yield* Effect.promise(() =>
          waitFor(() => closes.length > 0, { maxMs: 2000 }),
        );
        yield* closeClient(client);

        expect(closes.length).toBeGreaterThanOrEqual(1);
        const first = closes[0]!;
        expect(first.code).toBe(1000);
        expect(first.reason).toBe("normal"); // OQ-5 default, not "bye"
      }),
    );
  });

  it("round-trips the server's close code + reason for a 1011 (server error) close", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const closes: CloseInfo[] = [];
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url, {
          onDisconnect: (close) => {
            closes.push(close);
          },
        });
        yield* Effect.promise(() => connectP(client));
        yield* server.connections[0]!.close(1011, "boom");

        yield* Effect.promise(() =>
          waitFor(() => closes.length > 0, { maxMs: 2000 }),
        );
        yield* closeClient(client);

        expect(closes.length).toBeGreaterThanOrEqual(1);
        const first = closes[0]!;
        // Distinguishable from the 1000 test above (AC 5.4-4):
        // a hardcoded `{1000, "disconnect"}` would fail this assertion.
        expect(first.code).toBe(1011);
        expect(first.reason).toBe("boom");
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 1.0 (B.1) gating tests — client-side server-initiated RPC
// (handleServerRpc + dispatcher fiber + s2c response write-back)
// ─────────────────────────────────────────────────────────────────────

describe("Phase 1.0 (B.1) — handleServerRpc round-trip", () => {
  it("dispatches an inbound s2c request to the registered handler and writes the response back", async () => {
    await withTestServer(
      Effect.gen(function* () {
        // Server: auto-handshake; immediately AFTER replying to
        // auth/connect, send an s2c request to the client; capture every
        // subsequent inbound frame the client writes back. We're testing
        // the client's dispatcher fiber + handler registry + response
        // encoding.
        const server = yield* startTestServer((conn, raw) =>
          Effect.gen(function* () {
            const frame = JSON.parse(raw) as { id: string; method: string };
            if (frame.method === "auth/connect") {
              yield* conn.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  type: "response",
                  direction: "c2s",
                  id: frame.id,
                  result: { agentId: "agent-xyz", protocol: PROTOCOL_VERSION },
                }),
              );
              // Fire the s2c request straight after auth response. The
              // client's dispatcher fiber was forked into the connect
              // scope BEFORE auth/connect was sent, so the inbound queue
              // is live the moment we land here.
              yield* conn.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  type: "request",
                  direction: "s2c",
                  id: "srv-test-1",
                  method: "apps/onJoin",
                  params: { sessionId: "sess-A" },
                }),
              );
            }
          }),
        );
        const client = makeClient(server.url);
        // Register a handler BEFORE connect so the dispatcher fiber sees
        // it on the very first inbound s2c request.
        yield* client.handleServerRpc("apps/onJoin", (params) =>
          Effect.succeed({
            ack: true,
            saw: (params as { sessionId: string }).sessionId,
          }),
        );
        yield* Effect.promise(() => connectP(client));

        // Wait for the response frame the dispatcher writes back. The
        // server records every inbound frame in `received` — the s2c
        // response should appear after the client's auth/connect.
        const responseRaw = yield* Effect.promise(() =>
          waitFor(
            () =>
              server.connections[0]!.received.some((r) => {
                try {
                  const parsed = JSON.parse(r) as {
                    type?: string;
                    id?: string;
                  };
                  return (
                    parsed.type === "response" && parsed.id === "srv-test-1"
                  );
                } catch {
                  return false;
                }
              }),
            { maxMs: 2000 },
          ),
        ).pipe(
          Effect.flatMap(() =>
            Effect.sync(() =>
              server.connections[0]!.received.find((r) => {
                try {
                  const parsed = JSON.parse(r) as { id?: string };
                  return parsed.id === "srv-test-1";
                } catch {
                  return false;
                }
              }),
            ),
          ),
        );

        const parsedResponse = JSON.parse(responseRaw!) as {
          type: string;
          direction: string;
          id: string;
          result: { ack: boolean; saw: string };
        };
        expect(parsedResponse.type).toBe("response");
        expect(parsedResponse.direction).toBe("s2c");
        expect(parsedResponse.id).toBe("srv-test-1");
        expect(parsedResponse.result.ack).toBe(true);
        expect(parsedResponse.result.saw).toBe("sess-A");

        yield* closeClient(client);
      }),
    );
  });

  it("encodes a typed RpcServerError from the handler as a `response` frame with `error`", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const server = yield* startTestServer((conn, raw) =>
          Effect.gen(function* () {
            const frame = JSON.parse(raw) as { id: string; method: string };
            if (frame.method === "auth/connect") {
              yield* conn.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  type: "response",
                  direction: "c2s",
                  id: frame.id,
                  result: { agentId: "agent-xyz", protocol: PROTOCOL_VERSION },
                }),
              );
              yield* conn.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  type: "request",
                  direction: "s2c",
                  id: "srv-err-1",
                  method: "apps/onClose",
                  params: {},
                }),
              );
            }
          }),
        );
        const client = makeClient(server.url);
        yield* client.handleServerRpc("apps/onClose", () =>
          Effect.fail(
            new RpcServerError({
              code: -32099,
              message: "domain-rejected",
              data: { reason: "test" },
            }),
          ),
        );
        yield* Effect.promise(() => connectP(client));

        yield* Effect.promise(() =>
          waitFor(
            () =>
              server.connections[0]!.received.some((r) => {
                try {
                  const parsed = JSON.parse(r) as {
                    id?: string;
                    error?: unknown;
                  };
                  return (
                    parsed.id === "srv-err-1" && parsed.error !== undefined
                  );
                } catch {
                  return false;
                }
              }),
            { maxMs: 2000 },
          ),
        );

        const found = server.connections[0]!.received.find((r) => {
          try {
            return (JSON.parse(r) as { id?: string }).id === "srv-err-1";
          } catch {
            return false;
          }
        });
        const parsed = JSON.parse(found!) as {
          direction: string;
          error: { code: number; message: string; data: { reason: string } };
        };
        expect(parsed.direction).toBe("s2c");
        expect(parsed.error.code).toBe(-32099);
        expect(parsed.error.message).toBe("domain-rejected");
        expect(parsed.error.data.reason).toBe("test");

        yield* closeClient(client);
      }),
    );
  });

  it("rejects a duplicate handleServerRpc registration with DuplicateServerRpcHandlerError", async () => {
    const client = new MoltZapWsClient({
      serverUrl: "http://127.0.0.1:1",
      agentKey: "test",
    });
    const first = await Effect.runPromiseExit(
      client.handleServerRpc("apps/onJoin", () => Effect.succeed({})),
    );
    expect(Exit.isSuccess(first)).toBe(true);
    const second = await Effect.runPromiseExit(
      client.handleServerRpc("apps/onJoin", () => Effect.succeed({})),
    );
    expect(Exit.isFailure(second)).toBe(true);
    if (Exit.isFailure(second)) {
      const err = Cause.failureOption(second.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value._tag).toBe("DuplicateServerRpcHandlerError");
      }
    }
    await Effect.runPromise(client.close());
  });
});

// ─────────────────────────────────────────────────────────────────────
// Regression gate (review-295): runSync(client.close()) and
// runSync(client.disconnect()) must not throw AsyncFiberException after
// the s2c queue + dispatcher were added. The s2c machinery lives off the
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

describe("Phase 1.0 (B.1) — runSync teardown contract", () => {
  it("client.close() runs synchronously after a successful connect", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url);
        yield* Effect.promise(() => connectP(client));
        // Critical: this MUST be runSync, not runPromise. Throwing
        // AsyncFiberException here is the regression we're guarding.
        expect(() => Effect.runSync(client.close())).not.toThrow();
      }),
    );
  });

  it("client.disconnect() runs synchronously after a successful connect", async () => {
    await withTestServer(
      Effect.gen(function* () {
        const server = yield* startHandshakingServer(() => Effect.void);
        const client = makeClient(server.url);
        yield* Effect.promise(() => connectP(client));
        expect(() => Effect.runSync(client.disconnect())).not.toThrow();
        // Drain reconnect-fiber + runtime so vitest doesn't flag dangling work.
        yield* closeClient(client);
      }),
    );
  });
});
