/**
 * Live transport test for inbound messageId dedup: the server double-emits
 * the same `messageId` over a real WS transport, and the client's
 * `on("message", ...)` handler surfaces it exactly once.
 *
 * Exercises the full live-broadcast stack:
 *   - in-process `@effect/platform` WS server
 *   - `MoltZapService` connected through `MoltZapAgentClient` (no fake)
 *   - the service-level `on("message", ...)` handler is the
 *     observation surface, downstream of the per-conversation
 *     `seenMessageIds` window
 *
 * The dedup window lives at the `MoltZapService` layer, not the WS
 * frame layer; this property anchors to the surface where the
 * invariant actually binds (downstream handlers must surface ONE
 * message, not two).
 */
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Deferred, Effect, Either, Scope } from "effect";
import * as Socket from "@effect/platform/Socket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  Connect,
  MessageReceivedNotificationDefinition,
  PROTOCOL_VERSION,
  type RequestFrame,
} from "@moltzap/protocol";
import {
  agentId,
  conversationId,
  messageId,
  taskId,
  responseFrame,
  notificationFrame,
  validateRequestFrame,
  waitUntil,
} from "@moltzap/protocol/testing";
import { MoltZapService } from "../../../service.js";
import type { Message } from "@moltzap/protocol";
import { realSleep } from "../../../app-client-test-support.js";

const it = effectIt.scoped;
const LOCALHOST_HOST = "127.0.0.1";

const TEST_AGENT_ID = agentId("11111111-1111-4111-8111-111111111111");
const SENDER_AGENT_ID = agentId("22222222-2222-4222-8222-222222222222");
const TEST_CONV_ID = conversationId("33333333-3333-4333-8333-333333333333");
const TEST_MSG_ID = messageId("44444444-4444-4444-8444-444444444444");
const TEST_TASK_ID = taskId("66666666-6666-4666-8666-666666666666");

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

const helloOk = () => ({
  protocolVersion: PROTOCOL_VERSION,
  agentId: TEST_AGENT_ID,
  policy: TEST_POLICY,
});

const messageReceivedFrame = () =>
  notificationFrame(MessageReceivedNotificationDefinition, {
    taskId: TEST_TASK_ID,
    message: {
      id: TEST_MSG_ID,
      conversationId: TEST_CONV_ID,
      senderId: SENDER_AGENT_ID,
      parts: [{ type: "text", text: "double-emit-probe" }],
      createdAt: "2026-05-11T00:00:00.000Z",
    },
  });

interface ServerConn {
  readonly send: (raw: string) => Effect.Effect<void>;
}

interface DedupTestServer {
  readonly url: string;
  readonly firstConn: Deferred.Deferred<ServerConn>;
}

interface ConnectedService {
  readonly service: MoltZapService;
  readonly conn: ServerConn;
  readonly seen: Message[];
}

/**
 * Spin up an in-process WS server that auto-responds to `network/connect`
 * with `helloOk()`. Returns the bound URL and the most recently accepted
 * server-side connection (used by the test to script post-handshake
 * emissions).
 */
function startServer(): Effect.Effect<DedupTestServer, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const server = yield* NodeSocketServer.makeWebSocket({
      port: 0,
      host: LOCALHOST_HOST,
    });
    const addr = server.address;
    if (addr._tag !== "TcpAddress") {
      return yield* Effect.die("expected TcpAddress");
    }
    const firstConn = yield* Deferred.make<ServerConn>();
    yield* Effect.forkScoped(
      server
        .run((serverSock) => handleServerSocket(serverSock, firstConn))
        .pipe(Effect.ignore),
    );
    return {
      url: `http://${LOCALHOST_HOST}:${addr.port}`,
      firstConn,
    };
  });
}

type SocketWriter = (
  chunk: Uint8Array | string | Socket.CloseEvent,
) => Effect.Effect<void, Socket.SocketError>;

function handleServerSocket(
  serverSock: Socket.Socket,
  firstConn: Deferred.Deferred<ServerConn>,
): Effect.Effect<void, Socket.SocketError, Scope.Scope> {
  return Effect.gen(function* () {
    const write = yield* serverSock.writer;
    const conn: ServerConn = {
      send: (raw) => write(muxWrapServerFrame(raw)).pipe(Effect.ignore),
    };
    yield* Deferred.succeed(firstConn, conn);
    yield* serverSock.runRaw((data) => handleServerData(data, write));
  }).pipe(Effect.withSpan("dedup.handleServerSocket"));
}

function handleServerData(
  data: string | Uint8Array,
  write: SocketWriter,
): Effect.Effect<void, Socket.SocketError> {
  return Effect.gen(function* () {
    const parsed = parseRequestFrame(muxUnwrap(decodeServerData(data)));
    if (parsed === null) return;
    if (parsed.method !== Connect.name) return;
    yield* write(
      muxWrapServerFrame(
        JSON.stringify(responseFrame(parsed.id, { result: helloOk() })),
      ),
    ).pipe(Effect.ignore);
  });
}

function decodeServerData(data: string | Uint8Array): string {
  return typeof data === "string"
    ? data
    : new TextDecoder("utf-8").decode(data);
}

// The production `MoltZapService` multiplexes the socket with a `{ ch, f }`
// envelope (`mux.ts`) and the native engine mints NUMERIC ids the strict
// wire schema brands as strings. The in-process server mirrors that framing:
// unwrap + strip native extras + stringify a numeric id on receipt, wrap on
// send (responses on `c2s`, server-pushed notifications on `s2c`).
const NATIVE_EXTRAS = ["headers", "traceId", "spanId", "sampled"];
function asObject(raw: string): { readonly [k: string]: unknown } | null {
  const v = Either.getOrNull(Either.try(() => JSON.parse(raw) as unknown));
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as { readonly [k: string]: unknown })
    : null;
}
function muxUnwrap(raw: string): string {
  const outer = asObject(raw);
  const inner =
    outer !== null && typeof outer["f"] === "string" ? outer["f"] : raw;
  const parsed = asObject(inner);
  if (parsed === null) return inner;
  const frame: Record<string, unknown> = { ...parsed };
  for (const key of NATIVE_EXTRAS) delete frame[key];
  if (typeof frame["id"] === "number") frame["id"] = String(frame["id"]);
  return JSON.stringify(frame);
}
function muxWrapServerFrame(frame: string): string {
  const obj = asObject(frame);
  const channel =
    obj !== null && typeof obj["method"] === "string" ? "s2c" : "c2s";
  return JSON.stringify({ ch: channel, f: frame });
}

function parseRequestFrame(raw: string): RequestFrame | null {
  const parsed: unknown = JSON.parse(raw);
  if (!validateRequestFrame(parsed)) return null;
  return parsed;
}

function connectService(
  server: DedupTestServer,
): Effect.Effect<ConnectedService, unknown> {
  return Effect.gen(function* () {
    const service = new MoltZapService({
      serverUrl: server.url,
      agentKey: "test-key",
    });
    const seen: Message[] = [];
    service.on("message", ({ message }) => seen.push(message));
    yield* service.connect();
    const conn = yield* Deferred.await(server.firstConn);
    return { service, conn, seen };
  }).pipe(Effect.withSpan("dedup.connectService"));
}

function messageCountAtLeast(seen: readonly Message[], count: number) {
  return () => seen.length >= count;
}

function messageIds(messages: readonly Message[]) {
  return messages.map((message) => message.id);
}

function freshMessageFrame(): string {
  return JSON.stringify(
    notificationFrame(MessageReceivedNotificationDefinition, {
      taskId: TEST_TASK_ID,
      message: {
        id: messageId("55555555-5555-4555-8555-555555555555"),
        conversationId: TEST_CONV_ID,
        senderId: SENDER_AGENT_ID,
        parts: [{ type: "text", text: "fresh" }],
        createdAt: "2026-05-11T00:00:01.000Z",
      },
    }),
  );
}

function expectDuplicateFrameSurfacedOnce(seen: readonly Message[]): void {
  expect(seen.length).toBe(1);
  expect(seen[0]!.id).toBe(TEST_MSG_ID);
}

function expectDuplicateThenFresh(seen: readonly Message[]): void {
  expect(seen.length).toBe(2);
  expect(messageIds(seen)).toEqual([
    TEST_MSG_ID,
    messageId("55555555-5555-4555-8555-555555555555"),
  ]);
}

function dedupsDoubleEmit() {
  return Effect.gen(function* () {
    const { service, conn, seen } = yield* startServer().pipe(
      Effect.flatMap(connectService),
    );
    const frame = JSON.stringify(messageReceivedFrame());
    yield* conn.send(frame);
    yield* conn.send(frame);
    yield* waitUntil(messageCountAtLeast(seen, 1));
    yield* realSleep(200);
    expectDuplicateFrameSurfacedOnce(seen);
    service.close();
  });
}

function dedupsDuplicateThenFresh() {
  return Effect.gen(function* () {
    const { service, conn, seen } = yield* startServer().pipe(
      Effect.flatMap(connectService),
    );
    const dupFrame = JSON.stringify(messageReceivedFrame());
    yield* conn.send(dupFrame);
    yield* conn.send(dupFrame);
    yield* conn.send(freshMessageFrame());
    yield* waitUntil(messageCountAtLeast(seen, 2));
    yield* realSleep(200);
    expectDuplicateThenFresh(seen);
    service.close();
  });
}

describe("MoltZapService live transport — server double-emit dedup", () => {
  it(
    "surfaces the same messageId exactly once when the server emits it twice",
    dedupsDoubleEmit,
    30_000,
  );

  it(
    "surfaces a fresh messageId after a duplicate then a new id",
    dedupsDuplicateThenFresh,
    30_000,
  );
});
