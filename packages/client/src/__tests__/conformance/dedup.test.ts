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
import { describe, expect, it } from "vitest";
import { Effect, Exit, Scope } from "effect";
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

/**
 * Spin up an in-process WS server that auto-responds to `network/connect`
 * with `helloOk()`. Returns the bound URL and the most recently accepted
 * server-side connection (used by the test to script post-handshake
 * emissions).
 */
function startServer(): Effect.Effect<
  { url: string; firstConn: Promise<ServerConn> },
  unknown,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const server = yield* NodeSocketServer.makeWebSocket({
      port: 0,
      host: LOCALHOST_HOST,
    });
    const addr = server.address;
    if (addr._tag !== "TcpAddress") {
      return yield* Effect.die("expected TcpAddress");
    }
    let resolveFirst!: (conn: ServerConn) => void;
    const firstConn = new Promise<ServerConn>((res) => {
      resolveFirst = res;
    });
    yield* Effect.forkScoped(
      server
        .run((serverSock) =>
          Effect.gen(function* () {
            const write = yield* serverSock.writer;
            const conn: ServerConn = {
              send: (raw) => write(raw).pipe(Effect.ignore),
            };
            resolveFirst(conn);
            yield* serverSock.runRaw((data) =>
              Effect.gen(function* () {
                const raw =
                  typeof data === "string"
                    ? data
                    : new TextDecoder("utf-8").decode(data);
                const parsed: unknown = JSON.parse(raw);
                if (!validateRequestFrame(parsed)) {
                  // Drop non-request frames; the service only sends typed RPCs.
                  return;
                }
                const frame: RequestFrame = parsed;
                if (frame.method === Connect.name) {
                  yield* write(
                    JSON.stringify(Connect.encodeResponse(frame.id, helloOk())),
                  ).pipe(Effect.ignore);
                }
                // Other RPCs are not exercised; the test only needs the
                // post-handshake notification channel.
              }),
            );
          }),
        )
        .pipe(Effect.ignore),
    );
    return {
      url: `http://${LOCALHOST_HOST}:${addr.port}`,
      firstConn,
    };
  });
}

async function withScope<A>(
  effect: Effect.Effect<A, unknown, Scope.Scope>,
): Promise<A> {
  const scope = Effect.runSync(Scope.make());
  try {
    const typed = Scope.extend(effect, scope) as Effect.Effect<A, unknown>;
    return await Effect.runPromise(typed);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

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

describe("client conformance — server double-emit dedup", () => {
  it("surfaces the same messageId exactly once when the server emits it twice", async () => {
    await withScope(
      Effect.gen(function* () {
        const server = yield* startServer();
        const service = new MoltZapService({
          serverUrl: server.url,
          agentKey: "test-key",
        });
        const seen: Message[] = [];
        service.on("message", (m) => seen.push(m));

        yield* service.connect();
        const conn = yield* Effect.promise(() => server.firstConn);

        const frame = JSON.stringify(messageReceivedFrame());
        yield* conn.send(frame);
        yield* conn.send(frame);

        // Wait for the first frame to surface, then drain a quiet
        // window. A naively-non-deduping client would record a second
        // entry before 200ms elapses (the WS reader, the subscription
        // registry, and the service handler all complete well under
        // that bound on this in-process transport).
        yield* Effect.promise(() =>
          waitFor(() => seen.length >= 1, { maxMs: 2000 }),
        );
        yield* Effect.sleep("200 millis");

        expect(seen.length).toBe(1);
        expect(seen[0]!.id).toBe(TEST_MSG_ID);

        service.close();
      }),
    );
  }, 30_000);

  it("surfaces a fresh messageId after the server emits the duplicate followed by a new id", async () => {
    await withScope(
      Effect.gen(function* () {
        const server = yield* startServer();
        const service = new MoltZapService({
          serverUrl: server.url,
          agentKey: "test-key",
        });
        const seen: Message[] = [];
        service.on("message", (m) => seen.push(m));

        yield* service.connect();
        const conn = yield* Effect.promise(() => server.firstConn);

        // The dedup window must not poison the seen-set for unrelated
        // ids: a fresh id arriving after a duplicate id is surfaced.
        const dupFrame = JSON.stringify(messageReceivedFrame());
        const freshFrame = JSON.stringify(
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
        yield* conn.send(dupFrame);
        yield* conn.send(dupFrame);
        yield* conn.send(freshFrame);

        yield* Effect.promise(() =>
          waitFor(() => seen.length >= 2, { maxMs: 2000 }),
        );
        yield* Effect.sleep("200 millis");

        expect(seen.length).toBe(2);
        expect(seen.map((m) => m.id)).toEqual([
          TEST_MSG_ID,
          messageId("55555555-5555-4555-8555-555555555555"),
        ]);

        service.close();
      }),
    );
  }, 30_000);
});
