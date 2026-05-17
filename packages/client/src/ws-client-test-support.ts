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
import { createServer } from "node:net";
import { expect, it, vi } from "vitest";
import { it as itEffect } from "@effect/vitest";
import {
  Cause,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Scope,
  TestClock,
} from "effect";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as NodeCommandExecutor from "@effect/platform-node/NodeCommandExecutor";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Command from "@effect/platform/Command";
import * as Socket from "@effect/platform/Socket";

import {
  MoltZapWsClient,
  RPC_TIMEOUT_MS,
  type CloseInfo,
} from "./ws-client.js";
import {
  ForbiddenError,
  RpcTimeoutError,
  type ParamsOf,
} from "@moltzap/protocol";

import {
  AgentsLookupByName,
  DispatchAuthorize,
  Connect,
  ConversationsList,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  PROTOCOL_VERSION,
  type NotificationFrame,
  type RequestFrame,
  type RpcDefinition,
} from "@moltzap/protocol";
import {
  agentId,
  conversationId,
  messageId,
  JSON_RPC_VERSION,
  validateRequestFrame,
  validateResponseFrame,
} from "@moltzap/protocol/testing";

const effectTest = (
  name: string,
  effect: () => Effect.Effect<unknown, unknown>,
  timeout?: number,
): void => {
  const run = () => {
    expect.hasAssertions();
    return Effect.runPromise(effect());
  };
  if (timeout === undefined) {
    it(name, run);
    return;
  }
  it(name, run, timeout);
};
const scopedEffectTest = itEffect.scoped;

// Test fixtures for dispatch/authorize round-trip tests below. The
// previous partitioned-dispatcher harness provided these via
// `app-callback-test-requests.ts`; that file was deleted in the
// cutover. The simpler global-queue topology only needs valid
// `dispatch/authorize` params shaped to the descriptor.
const DISPATCH_TASK_A_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DISPATCH_TASK_B_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DISPATCH_CONV_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DISPATCH_RECIPIENT_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DISPATCH_SENDER_UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DISPATCH_MESSAGE_UUID = "11111111-1111-4111-8111-111111111111";
const SESSION_A = DISPATCH_TASK_A_UUID;
const SESSION_B = DISPATCH_TASK_B_UUID;
const dispatchRequestParams = (taskId: string) => ({
  taskId,
  appId: "app-test",
  conversationId: DISPATCH_CONV_UUID,
  recipient: { agentId: DISPATCH_RECIPIENT_UUID, ownerId: "owner-test" },
  message: {
    id: DISPATCH_MESSAGE_UUID,
    senderAgentId: DISPATCH_SENDER_UUID,
    parts: [{ type: "text" as const, text: "hello" }],
  },
  attempt: 0,
});
type DispatchRequestParams = ReturnType<typeof dispatchRequestParams>;

// ── Test server helpers ────────────────────────────────────────────────

const LOCALHOST_HOST = "127.0.0.1";
const SS_COMMAND = "/usr/bin/ss";
const TEST_AGENT_ID = agentId("11111111-1111-4111-8111-111111111111");
const RECONNECT_AGENT_ID = agentId("22222222-2222-4222-8222-222222222222");
const TEST_MESSAGE_ID = messageId("44444444-4444-4444-8444-444444444444");
const NORMAL_CLOSE_CODE = 1000;
const SERVER_ERROR_CLOSE_CODE = 1011;
const WAIT_FOR_DEFAULT_TIMEOUT_MS = 2_000;
const CONNECT_FAILURE_MAX_MS = 3_000;
const REFUSED_CONNECT_MAX_MS = 15_000;
const REFUSED_CONNECT_TEST_TIMEOUT_MS = 20_000;
const REALTIME_POLL_TIMEOUT_MS = 2_000;
const POST_TIMEOUT_SETTLE_MS = 50;
const MALFORMED_FRAME_COUNT = 101;
const MALFORMED_FRAME_FLUSH_MS = 300;
const CLIENT_DRAIN_COUNT = 10;
const CLOSE_PROPAGATION_TIMEOUT_MS = 1_000;
const STALE_PORT_TEST_TIMEOUT_MS = 15_000;
const CLOSE_INFO_WAIT_MS = 2_000;
const HANDLER_REJECTION_CODE = ForbiddenError.code;
const WAIT_FOR_POLL_INTERVAL_MS = 5;
const NORMAL_CLOSE_REASON = "normal";
const SERVER_ERROR_REASON = "boom";
const SERVER_TEST_REQUEST_ID = "srv-test-1";
const SERVER_ERROR_REQUEST_ID = "srv-err-1";
const GRANT_DECISION = "grant";
const DOMAIN_REJECTED_MESSAGE = "domain-rejected";
const DOMAIN_REJECTED_REASON = "test";
const DUPLICATE_HANDLER_ERROR_TAG = "DuplicateServerRpcHandlerError";
const TEST_CONVERSATION_ID = conversationId(
  "33333333-3333-4333-8333-333333333333",
);
const TEST_POLICY = {
  maxMessageBytes: 1_000_000,
  maxPartsPerMessage: 10,
  maxTextLength: 32_768,
  maxGroupParticipants: 100,
  heartbeatIntervalMs: 30_000,
  rateLimits: {
    messagesPerMinute: 60,
    requestsPerMinute: 120,
  },
};

const helloOk = (agentId = TEST_AGENT_ID) => ({
  protocolVersion: PROTOCOL_VERSION,
  agentId,
  policy: TEST_POLICY,
});
const TEST_MESSAGE = {
  id: TEST_MESSAGE_ID,
  conversationId: TEST_CONVERSATION_ID,
  senderId: TEST_AGENT_ID,
  parts: [{ type: "text" as const, text: "hello" }],
  createdAt: "2026-05-03T00:00:00.000Z",
};
const messageReceivedFrame = () =>
  MessageReceivedNotificationDefinition.encode({
    message: TEST_MESSAGE,
  });

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
type SocketWriter = Effect.Effect.Success<Socket.Socket["writer"]>;
interface MutableRef<A> {
  current: A;
}

interface TestServer {
  readonly url: string;

  /**
   * Accumulates every TestServerConnection ever accepted. Tests assert on
   * it to check e.g. no reconnect happened (length === 1).
   */
  readonly connections: ReadonlyArray<TestServerConnection>;
}

class ClosedLocalPortError extends Data.TaggedError("ClosedLocalPortError")<{
  readonly cause: unknown;
}> {}

class TestPromiseError extends Data.TaggedError("TestPromiseError")<{
  readonly cause: unknown;
}> {}

class WaitForTimeoutError extends Data.TaggedError("WaitForTimeoutError")<{
  readonly timeoutMs: number;
}> {}

const tryPromise = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new TestPromiseError({ cause }),
  });

function rawSocketDataToString(data: string | Uint8Array): string {
  return typeof data === "string"
    ? data
    : new TextDecoder("utf-8").decode(data);
}

function handleTestServerRawData(
  conn: TestServerConnection,
  receivedList: string[],
  handler: ServerHandler,
  data: string | Uint8Array,
): Effect.Effect<void> {
  const raw = rawSocketDataToString(data);
  receivedList.push(raw);
  return handler(conn, raw);
}

const parseJsonOption = (raw: string): Option.Option<unknown> =>
  Effect.runSync(
    Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) => new TestPromiseError({ cause }),
    }).pipe(Effect.option),
  );

function responseFrameHasId(raw: string, id: string): boolean {
  const parsed = parseJsonOption(raw);
  return (
    Option.isSome(parsed) &&
    validateResponseFrame(parsed.value) &&
    parsed.value.id === id
  );
}

function errorResponseFrameHasId(raw: string, id: string): boolean {
  const parsed = parseJsonOption(raw);
  return (
    Option.isSome(parsed) &&
    validateResponseFrame(parsed.value) &&
    parsed.value.id === id &&
    "error" in parsed.value
  );
}

function firstConnection(server: TestServer): TestServerConnection {
  return server.connections[0]!;
}

function findResponseRaw(server: TestServer, id: string): string | undefined {
  return firstConnection(server).received.find((raw) =>
    responseFrameHasId(raw, id),
  );
}

function waitForResponseRaw(
  server: TestServer,
  id: string,
): Effect.Effect<string | undefined, WaitForTimeoutError> {
  return waitFor(() => findResponseRaw(server, id) !== undefined, {
    maxMs: CLOSE_INFO_WAIT_MS,
  }).pipe(Effect.map(() => findResponseRaw(server, id)));
}

function waitForErrorResponse(
  server: TestServer,
  id: string,
): Effect.Effect<void, WaitForTimeoutError> {
  return waitFor(
    () =>
      firstConnection(server).received.some((raw) =>
        errorResponseFrameHasId(raw, id),
      ),
    { maxMs: CLOSE_INFO_WAIT_MS },
  );
}

function makeTestServerConnection(
  write: SocketWriter,
  receivedList: string[],
): TestServerConnection {
  return {
    send: (raw) => write(raw).pipe(Effect.ignore),
    close: (code = NORMAL_CLOSE_CODE, reason = "test close") =>
      write(new Socket.CloseEvent(code, reason)).pipe(Effect.ignore),
    get received(): ReadonlyArray<string> {
      return receivedList;
    },
  };
}

function runTestServerSocket(
  connections: TestServerConnection[],
  handler: ServerHandler,
  serverSock: Socket.Socket,
): Effect.Effect<void, Socket.SocketError, Scope.Scope> {
  return Effect.gen(function* () {
    const write = yield* serverSock.writer;
    const receivedList: string[] = [];
    const conn = makeTestServerConnection(write, receivedList);
    connections.push(conn);
    yield* serverSock.runRaw((data) =>
      handleTestServerRawData(conn, receivedList, handler, data),
    );
  });
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
      host: LOCALHOST_HOST,
    });
    const addr = server.address;
    if (addr._tag !== "TcpAddress") {
      return yield* Effect.die("expected TcpAddress");
    }
    const connections: TestServerConnection[] = [];

    yield* Effect.forkScoped(
      server
        .run((serverSock) =>
          runTestServerSocket(connections, handler, serverSock),
        )
        .pipe(Effect.ignore),
    );

    return {
      url: `http://${LOCALHOST_HOST}:${addr.port}`,
      get connections() {
        return connections;
      },
    };
  });

const findClosedLocalPort = (): Effect.Effect<number, ClosedLocalPortError> =>
  Effect.async<number, ClosedLocalPortError>((resume) => {
    const server = createServer();
    const fail = (cause: unknown): void => {
      resume(Effect.fail(new ClosedLocalPortError({ cause })));
    };
    server.once("error", fail);
    server.listen(0, LOCALHOST_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        fail("expected TCP server address");
        return;
      }
      server.close((err) => {
        if (err) {
          fail(err);
          return;
        }
        resume(Effect.succeed(address.port));
      });
    });
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
 * Build a client, connect against the given URL, complete the network/connect
 * handshake, and return the live client. The server handler auto-responds
 * to `network/connect` with a canned HelloOk; subsequent frames route through
 * the outer `handler`.
 */
interface ClientHarness {
  readonly client: MoltZapWsClient;
  readonly serverConn: TestServerConnection;
  readonly logger: ReturnType<typeof makeLogger>;
  readonly onNotificationCalls: Array<unknown>;
  readonly onDisconnectCalls: Array<void>;
  readonly onReconnectCalls: Array<unknown>;
}

interface MakeClientOverrides {
  readonly onNotification?: (evt: NotificationFrame) => void;
  readonly onDisconnect?: (close: CloseInfo) => void;
  readonly onReconnect?: (hello: unknown) => void;
  readonly logger?: ClientHarness["logger"];
}

const ignoreDisconnect = (_close: CloseInfo): void => undefined;
const ignoreReconnect = (_hello: unknown): void => undefined;

const notificationHandler =
  (cb: (evt: NotificationFrame) => void) => (frame: NotificationFrame) =>
    Effect.sync(() => cb(frame));

const connectClient = (client: MoltZapWsClient) => client.connect();

const sendRpcEffect = <D extends RpcDefinition<string, any, any>>(
  client: MoltZapWsClient,
  definition: D,
  params: ParamsOf<D>,
) => client.sendRpc(definition, params);

function expectEffectFailure<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  pattern: RegExp,
) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(String(failure.value)).toMatch(pattern);
      }
    }
  });
}

const closeClient = (client: MoltZapWsClient): Effect.Effect<void, never> =>
  client.close();

/**
 * Start a server whose handler auto-responds to `network/connect` and forwards
 * everything else to the test's `handler`. Useful for tests that only care
 * about post-handshake behaviour.
 */
const startHandshakingServer = (
  handler: (
    conn: TestServerConnection,
    raw: string,
    frame: RequestFrame,
  ) => Effect.Effect<void>,
): Effect.Effect<TestServer, unknown, Scope.Scope> =>
  startTestServer((conn, raw) =>
    Effect.gen(function* () {
      const parsed: unknown = JSON.parse(raw);
      if (!validateRequestFrame(parsed)) {
        return yield* Effect.die("expected JSON-RPC request frame");
      }
      const frame = parsed;
      if (frame.method === Connect.name) {
        yield* conn.send(
          JSON.stringify(Connect.encodeResponse(frame.id, helloOk())),
        );
        return;
      }
      yield* handler(conn, raw, frame);
    }),
  );

function sendDispatchAuthorizeAfterConnect(
  conn: TestServerConnection,
  raw: string,
  requestId: string,
  params: DispatchRequestParams,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const parsed: unknown = JSON.parse(raw);
    if (!validateRequestFrame(parsed)) {
      return yield* Effect.die("expected JSON-RPC request frame");
    }
    const frame = parsed;
    if (frame.method === Connect.name) {
      yield* conn.send(
        JSON.stringify(Connect.encodeResponse(frame.id, helloOk())),
      );
      yield* conn.send(
        JSON.stringify(DispatchAuthorize.encodeRequest(requestId, params)),
      );
    }
  });
}

function startDispatchAuthorizeServer(
  requestId: string,
  params: DispatchRequestParams,
): Effect.Effect<TestServer, unknown, Scope.Scope> {
  return startTestServer((conn, raw) =>
    sendDispatchAuthorizeAfterConnect(conn, raw, requestId, params),
  );
}

const setRef =
  <A>(ref: MutableRef<A>) =>
  (value: A): void => {
    ref.current = value;
  };

function startReconnectServer(
  authResponses: MutableRef<number>,
): Effect.Effect<TestServer, unknown, Scope.Scope> {
  return startTestServer((conn, raw) =>
    Effect.gen(function* () {
      const parsed: unknown = JSON.parse(raw);
      if (!validateRequestFrame(parsed)) {
        return yield* Effect.die("expected JSON-RPC request frame");
      }
      const frame = parsed;
      if (frame.method === Connect.name) {
        authResponses.current += 1;
        yield* conn.send(
          JSON.stringify(
            Connect.encodeResponse(frame.id, helloOk(RECONNECT_AGENT_ID)),
          ),
        );
      }
    }),
  );
}

function sendMalformedFramesAndResponse(
  conn: TestServerConnection,
  _raw: string,
  frame: RequestFrame,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (frame.method !== ConversationsList.name) return;
    yield* conn.send("not json at all");
    yield* conn.send(JSON.stringify({ jsonrpc: JSON_RPC_VERSION, result: {} }));
    yield* conn.send(
      JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: frame.id }),
    );
    yield* conn.send(
      JSON.stringify(
        ConversationsList.encodeResponse(frame.id, {
          conversations: [],
        }),
      ),
    );
  });
}

function sendPaddedNotificationAndResponse(
  conn: TestServerConnection,
  _raw: string,
  frame: RequestFrame,
): Effect.Effect<void> {
  if (frame.method !== ConversationsList.name) return Effect.void;
  return conn.send(
    JSON.stringify(messageReceivedFrame()) +
      "\u0000" +
      JSON.stringify(
        ConversationsList.encodeResponse(frame.id, {
          conversations: [],
        }),
      ),
  );
}

function sendMalformedFrameBurst(
  conn: TestServerConnection,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let i = 0; i < MALFORMED_FRAME_COUNT; i++) {
      yield* conn.send("definitely not json " + i);
    }
  });
}

function startAgentsLookupByNameServer(
  captured: MutableRef<RequestFrame | null>,
): Effect.Effect<TestServer, unknown, Scope.Scope> {
  return startHandshakingServer((conn, _raw, frame) =>
    Effect.gen(function* () {
      captured.current = frame;
      yield* conn.send(
        JSON.stringify(
          AgentsLookupByName.encodeResponse(frame.id, { agents: [] }),
        ),
      );
    }),
  );
}

function connectClientForServer(
  url: string,
): Effect.Effect<
  MoltZapWsClient,
  Effect.Effect.Error<ReturnType<typeof connectClient>>
> {
  const client = makeClient(url);
  return connectClient(client).pipe(Effect.map(() => client));
}

function grantDispatchAuthorizeHandler(
  observedTaskId: MutableRef<string | null>,
) {
  return (params: ParamsOf<typeof DispatchAuthorize>) =>
    Effect.sync(() => {
      observedTaskId.current = params.taskId;
      return { admission: { decision: GRANT_DECISION as "grant" } };
    });
}

/**
 * Promise-returning wrapper that both runs a test Effect and keeps the scope
 * alive until the Effect completes. Tests that need a server scope should
 * use `withTestServer` rather than mutating a Scope manually.
 */
const withTestServer = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E> => Effect.scoped(effect);

/**
 * Poll until `pred()` is true or `maxMs` elapses. The legacy test file used a
 * microtask-based loop; we keep that cadence to match the legacy behaviour
 * when synchronisation is driven by wall-clock timing in the test harness.
 */
function waitFor(
  pred: () => boolean,
  { maxMs = WAIT_FOR_DEFAULT_TIMEOUT_MS }: { maxMs?: number } = {},
): Effect.Effect<void, WaitForTimeoutError> {
  const deadline = Date.now() + maxMs;
  return Effect.async<void, WaitForTimeoutError>((resume) => {
    const tick = (): void => {
      if (pred()) {
        resume(Effect.void);
        return;
      }
      if (Date.now() > deadline) {
        resume(Effect.fail(new WaitForTimeoutError({ timeoutMs: maxMs })));
        return;
      }
      setTimeout(tick, WAIT_FOR_POLL_INTERVAL_MS);
    };
    tick();
  });
}

const realSleep = (ms: number): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), ms);
    return Effect.sync(() => clearTimeout(timer));
  });

const closeWaitSocketOutput = Command.make(
  SS_COMMAND,
  "-tn",
  "state",
  "CLOSE-WAIT",
).pipe(
  Command.string,
  Effect.catchAll(() => Effect.succeed("")),
  Effect.provide(NodeCommandExecutor.layer),
  Effect.provide(NodeFileSystem.layer),
);

/**
 * Build a `MoltZapWsClient`. Spec #222 OQ-4 deletion: `onNotification` is no
 * longer a constructor option; tests that previously stashed an
 * `onNotification` callback now register a `subscribe({}, …)` subscription
 * post-construction. The helper accepts the same `onNotification` callback as
 * a convenience and wires it through the new subscription registry,
 * keeping migration noise local to the helper.
 */
function makeClient(
  url: string,
  overrides: MakeClientOverrides = {},
): MoltZapWsClient {
  const {
    onNotification,
    onDisconnect = ignoreDisconnect,
    onReconnect = ignoreReconnect,
    logger = makeLogger(),
  } = overrides;
  const client = new MoltZapWsClient({
    serverUrl: url,
    agentKey: "test-key",
    onDisconnect,
    onReconnect,
    logger,
  });
  if (onNotification !== undefined) {
    Effect.runSync(client.subscribe({}, notificationHandler(onNotification)));
  }
  return client;
}

export {
  AgentsLookupByName,
  Connect,
  ConversationsList,
  DispatchAuthorize,
  Duration,
  Effect,
  Exit,
  Fiber,
  ForbiddenError,
  MessageReceivedNotificationDefinition,
  MessagesSend,
  MoltZapWsClient,
  Option,
  PROTOCOL_VERSION,
  RpcTimeoutError,
  Scope,
  TestClock,
  agentId,
  closeClient,
  connectClient,
  connectClientForServer,
  conversationId,
  dispatchRequestParams,
  effectTest,
  scopedEffectTest,
  expectEffectFailure,
  findClosedLocalPort,
  findResponseRaw,
  firstConnection,
  grantDispatchAuthorizeHandler,
  helloOk,
  makeClient,
  makeLogger,
  messageId,
  messageReceivedFrame,
  sendMalformedFrameBurst,
  sendMalformedFramesAndResponse,
  sendPaddedNotificationAndResponse,
  sendRpcEffect,
  setRef,
  startAgentsLookupByNameServer,
  startDispatchAuthorizeServer,
  startHandshakingServer,
  startReconnectServer,
  startTestServer,
  tryPromise,
  validateRequestFrame,
  validateResponseFrame,
  waitFor,
  realSleep,
  waitForErrorResponse,
  waitForResponseRaw,
  withTestServer,
  closeWaitSocketOutput,
  JSON_RPC_VERSION,
  RPC_TIMEOUT_MS,
  LOCALHOST_HOST,
  TEST_AGENT_ID,
  RECONNECT_AGENT_ID,
  SESSION_A,
  SESSION_B,
  TEST_MESSAGE_ID,
  NORMAL_CLOSE_CODE,
  SERVER_ERROR_CLOSE_CODE,
  WAIT_FOR_DEFAULT_TIMEOUT_MS,
  CONNECT_FAILURE_MAX_MS,
  REFUSED_CONNECT_MAX_MS,
  REFUSED_CONNECT_TEST_TIMEOUT_MS,
  REALTIME_POLL_TIMEOUT_MS,
  POST_TIMEOUT_SETTLE_MS,
  MALFORMED_FRAME_COUNT,
  MALFORMED_FRAME_FLUSH_MS,
  CLIENT_DRAIN_COUNT,
  CLOSE_PROPAGATION_TIMEOUT_MS,
  STALE_PORT_TEST_TIMEOUT_MS,
  CLOSE_INFO_WAIT_MS,
  HANDLER_REJECTION_CODE,
  WAIT_FOR_POLL_INTERVAL_MS,
  NORMAL_CLOSE_REASON,
  SERVER_ERROR_REASON,
  SERVER_TEST_REQUEST_ID,
  SERVER_ERROR_REQUEST_ID,
  GRANT_DECISION,
  DOMAIN_REJECTED_MESSAGE,
  DOMAIN_REJECTED_REASON,
  DUPLICATE_HANDLER_ERROR_TAG,
  TEST_CONVERSATION_ID,
  TEST_POLICY,
  TEST_MESSAGE,
};
export type {
  ClientHarness,
  CloseInfo,
  DispatchRequestParams,
  MakeClientOverrides,
  MutableRef,
  NotificationFrame,
  RequestFrame,
  RpcDefinition,
  ServerHandler,
  SocketWriter,
  TestServer,
  TestServerConnection,
};
