/**
 * Conformance test for inbound messageId dedup: the server double-emits
 * the same `messageId` over a real WS transport, and the client's
 * `on("message", ...)` handler surfaces it exactly once.
 *
 * Exercises the full live-broadcast stack:
 *   - in-process `@effect/platform` WS server
 *   - `MoltZapService` connected through `MoltZapWsClient` (no fake)
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
import { Data, Deferred, Effect, Scope } from "effect";
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
  validateRequestFrame,
} from "@moltzap/protocol/testing";
import { MoltZapService } from "../../service.js";
import type { Message } from "@moltzap/protocol";

const it = effectIt.scoped;
const LOCALHOST_HOST = "127.0.0.1";

const TEST_AGENT_ID = agentId("11111111-1111-4111-8111-111111111111");
const SENDER_AGENT_ID = agentId("22222222-2222-4222-8222-222222222222");
const TEST_CONV_ID = conversationId("33333333-3333-4333-8333-333333333333");
const TEST_MSG_ID = messageId("44444444-4444-4444-8444-444444444444");

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
  MessageReceivedNotificationDefinition.encode({
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

class WaitForTimedOut extends Data.TaggedError("WaitForTimedOut")<{
  readonly message: string;
}> {}

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

function handleServerSocket(
  serverSock: Socket.Socket,
  firstConn: Deferred.Deferred<ServerConn>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const write = yield* serverSock.writer;
    const conn: ServerConn = {
      send: (raw) => write(raw).pipe(Effect.ignore),
    };
    yield* Deferred.succeed(firstConn, conn);
    yield* serverSock.runRaw((data) => handleServerData(data, write));
  }).pipe(Effect.withSpan("dedup.handleServerSocket"));
}

function handleServerData(
  data: string | Uint8Array,
  write: (raw: string) => Effect.Effect<void>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const parsed = parseRequestFrame(decodeServerData(data));
    if (parsed === null) return;
    if (parsed.method !== Connect.name) return;
    yield* write(
      JSON.stringify(Connect.encodeResponse(parsed.id, helloOk())),
    ).pipe(Effect.ignore);
  });
}

function decodeServerData(data: string | Uint8Array): string {
  return typeof data === "string"
    ? data
    : new TextDecoder("utf-8").decode(data);
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
    service.on("message", (message) => seen.push(message));
    yield* service.connect();
    const conn = yield* Deferred.await(server.firstConn);
    return { service, conn, seen };
  }).pipe(Effect.withSpan("dedup.connectService"));
}

function waitFor(
  pred: () => boolean,
  { maxMs = 2000 }: { maxMs?: number } = {},
): Effect.Effect<void, WaitForTimedOut> {
  return Effect.gen(function* () {
    const deadline = Date.now() + maxMs;
    while (!pred()) {
      if (Date.now() > deadline) {
        return yield* Effect.fail(
          new WaitForTimedOut({
            message: "waitFor: condition not satisfied in time",
          }),
        );
      }
      yield* Effect.sleep("5 millis");
    }
  });
}

function messageCountAtLeast(seen: readonly Message[], count: number) {
  return () => seen.length >= count;
}

function messageIds(messages: readonly Message[]) {
  return messages.map((message) => message.id);
}

function freshMessageFrame(): string {
  return JSON.stringify(
    MessageReceivedNotificationDefinition.encode({
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
    yield* waitFor(messageCountAtLeast(seen, 1), { maxMs: 2000 });
    yield* Effect.sleep("200 millis");
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
    yield* waitFor(messageCountAtLeast(seen, 2), { maxMs: 2000 });
    yield* Effect.sleep("200 millis");
    expectDuplicateThenFresh(seen);
    service.close();
  });
}

describe("client conformance — server double-emit dedup", () => {
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
