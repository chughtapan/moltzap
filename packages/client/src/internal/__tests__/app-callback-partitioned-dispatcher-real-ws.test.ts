/**
 * Integration: `MoltZapWsClient` end-to-end deadlock reproducer.
 *
 * Spec: moltzap#356 §8 (test plan, file 5 — moved from app-sdk to
 * packages/client because the dispatcher behaviour under test is at
 * the @moltzap/client layer, and packages/client already has the
 * in-process WS server helper pattern needed for full-transport
 * tests; see PR body "Deviations" for the rationale).
 *
 * Boots an in-process `@effect/platform-node` WebSocket server,
 * connects a real `MoltZapWsClient`, registers two competing appCallback
 * handlers (`before_dispatch` parks on a Deferred;
 * `before_message_delivery` resolves it), and asserts both replies
 * round-trip back to the server. Pre-#356 this hangs; post-#356 it
 * completes via the partitioned dispatcher's
 * `(sessionId, conversationId, hookKind)` keying.
 *
 * No mocks — full transport, full schema validation, real fibers.
 */
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { Deferred, Effect, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { MoltZapWsClient } from "../../ws-client.js";

import {
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  Connect,
  PROTOCOL_VERSION,
  jsonRpcStringId,
  requestFrame,
  responseFrame,
  validators,
} from "@moltzap/protocol";
import {
  beforeDispatchParams,
  beforeMessageDeliveryParams,
  CONV_X,
  SESSION_A,
  SESSION_B,
} from "./app-callback-test-requests.js";

const TEST_AGENT_ID = "11111111-1111-4111-8111-111111111111";
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
  conversations: [],
  unreadCounts: {},
  policy: TEST_POLICY,
});

/**
 * Per-connection context exposed to the test server handler.
 */
interface ServerConn {
  readonly send: (raw: string) => Effect.Effect<void>;
  readonly received: ReadonlyArray<string>;
}

/**
 * Spin up an in-process WS server on 127.0.0.1:0. Caller owns the
 * provided scope; when it closes the server shuts down.
 */
function startWsServer(
  handler: (conn: ServerConn, raw: string) => Effect.Effect<void>,
): Effect.Effect<{ url: string; conns: ServerConn[] }, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const server = yield* NodeSocketServer.makeWebSocket({
      port: 0,
      host: "127.0.0.1",
    });
    const addr = server.address;
    if (addr._tag !== "TcpAddress") {
      return yield* Effect.die("expected TcpAddress");
    }
    const conns: ServerConn[] = [];
    yield* Effect.forkScoped(
      server
        .run((sock) =>
          Effect.gen(function* () {
            const write = yield* sock.writer;
            const received: string[] = [];
            const conn: ServerConn = {
              send: (raw) => write(raw).pipe(Effect.ignore),
              get received(): ReadonlyArray<string> {
                return received;
              },
            };
            conns.push(conn);
            yield* sock.runRaw((data) =>
              Effect.gen(function* () {
                const raw =
                  typeof data === "string"
                    ? data
                    : new TextDecoder("utf-8").decode(data);
                received.push(raw);
                yield* handler(conn, raw);
              }),
            );
          }),
        )
        .pipe(Effect.ignore),
    );
    return { url: `http://${addr.hostname}:${addr.port}`, conns };
  });
}

/** Connect a client, complete auth handshake. */
async function connect(client: MoltZapWsClient): Promise<unknown> {
  return Effect.runPromise(client.connect() as Effect.Effect<unknown, never>);
}

async function close(client: MoltZapWsClient): Promise<void> {
  await Effect.runPromise(client.close());
}

function responseIds(rawFrames: ReadonlyArray<string>): ReadonlyArray<string> {
  return rawFrames.flatMap((raw) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return validators.responseFrame(parsed) && typeof parsed.id === "string"
        ? [parsed.id]
        : [];
    } catch {
      return [];
    }
  });
}

describe("integration: AppHost + partitioned appCallback dispatcher", () => {
  it("two competing handlers (before_dispatch + before_message_delivery) for the " +
    "same conversation: parked before_dispatch resumes after sibling " +
    "before_message_delivery completes — both replies ship to the server", async () => {
    // Pre-#356 (single-fiber dispatcher) this test would hang
    // forever — vitest's testTimeout is the only thing that
    // catches it. Post-#356 (partitioned by hookKind) the two
    // handlers run on independent fibers, the parking deferred
    // fires from the sibling, and both replies ship.
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startWsServer((conn, raw) =>
            Effect.gen(function* () {
              const parsed: unknown = JSON.parse(raw);
              if (!validators.requestFrame(parsed)) {
                return yield* Effect.die("expected JSON-RPC request frame");
              }
              const frame = parsed;
              if (frame.method === Connect.name) {
                yield* conn.send(
                  JSON.stringify(
                    responseFrame(frame.id, {
                      result: helloOk(),
                    }),
                  ),
                );
                // Fire BOTH appCallback requests for the SAME (S, C). With
                // pre-#356 dispatching they queue on one fiber and
                // deadlock; with #356 they run concurrently.
                yield* conn.send(
                  JSON.stringify(
                    requestFrame(
                      jsonRpcStringId("rpc-bd-1"),
                      AppsOnBeforeDispatch,
                      beforeDispatchParams(SESSION_A, CONV_X),
                    ),
                  ),
                );
                yield* conn.send(
                  JSON.stringify(
                    requestFrame(
                      jsonRpcStringId("rpc-bmd-1"),
                      AppsOnBeforeMessageDelivery,
                      beforeMessageDeliveryParams(SESSION_A, CONV_X),
                    ),
                  ),
                );
              }
            }),
          );

          const client = new MoltZapWsClient({
            serverUrl: server.url,
            agentKey: "k",
            logger: {
              info: () => {},
              warn: () => {},
              error: () => {},
            },
          });

          // Park the dispatch handler. The delivery handler resolves
          // the parking Deferred — pre-#356 this would never run
          // because both queue on a single dispatch fiber.
          const release = yield* Deferred.make<void>();
          yield* client.handleServerRpc(AppsOnBeforeDispatch, () =>
            Effect.gen(function* () {
              yield* Deferred.await(release);
              return { admission: { decision: "grant" } };
            }),
          );
          yield* client.handleServerRpc(AppsOnBeforeMessageDelivery, () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(release, undefined);
              return { block: false };
            }),
          );

          yield* Effect.promise(() => connect(client));

          // Wait for both replies to land at the server.
          const deadline = Date.now() + 4000;
          let bothReplied = false;
          while (Date.now() < deadline) {
            const conn = server.conns[0];
            if (conn) {
              const replyIds = responseIds(conn.received);
              if (
                replyIds.includes("rpc-bd-1") &&
                replyIds.includes("rpc-bmd-1")
              ) {
                bothReplied = true;
                break;
              }
            }
            yield* Effect.sleep("20 millis");
          }
          yield* Effect.promise(() => close(client));
          return bothReplied;
        }),
      ),
    );
    expect(result).toBe(true);
  }, /* per-test timeout */ 6000);

  it("concurrent handlers across two different sessions complete independently " +
    "(slow handler in session A does not delay session B)", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startWsServer((conn, raw) =>
            Effect.gen(function* () {
              const parsed: unknown = JSON.parse(raw);
              if (!validators.requestFrame(parsed)) {
                return yield* Effect.die("expected JSON-RPC request frame");
              }
              const frame = parsed;
              if (frame.method === Connect.name) {
                yield* conn.send(
                  JSON.stringify(
                    responseFrame(frame.id, {
                      result: helloOk(),
                    }),
                  ),
                );
                // Session A: park forever (until release).
                yield* conn.send(
                  JSON.stringify(
                    requestFrame(
                      jsonRpcStringId("rpc-A"),
                      AppsOnBeforeDispatch,
                      beforeDispatchParams(SESSION_A, CONV_X),
                    ),
                  ),
                );
                // Session B: must complete despite A being parked.
                yield* conn.send(
                  JSON.stringify(
                    requestFrame(
                      jsonRpcStringId("rpc-B"),
                      AppsOnBeforeDispatch,
                      beforeDispatchParams(SESSION_B, CONV_X),
                    ),
                  ),
                );
              }
            }),
          );

          const release = yield* Deferred.make<void>();
          const client = new MoltZapWsClient({
            serverUrl: server.url,
            agentKey: "k",
            logger: {
              info: () => {},
              warn: () => {},
              error: () => {},
            },
          });
          yield* client.handleServerRpc(AppsOnBeforeDispatch, (params) =>
            Effect.gen(function* () {
              if (params.sessionId === SESSION_A) {
                yield* Deferred.await(release);
              }
              return { admission: { decision: "grant" } };
            }),
          );
          yield* Effect.promise(() => connect(client));

          const deadline = Date.now() + 4000;
          let bRan = false;
          while (Date.now() < deadline) {
            const conn = server.conns[0];
            if (conn) {
              const replyIds = responseIds(conn.received);
              if (replyIds.includes("rpc-B")) {
                bRan = true;
                break;
              }
            }
            yield* Effect.sleep("20 millis");
          }
          // Release A so close() doesn't have to interrupt a parked
          // handler.
          yield* Deferred.succeed(release, undefined);
          yield* Effect.promise(() => close(client));
          return bRan;
        }),
      ),
    );
    expect(result).toBe(true);
  }, /* per-test timeout */ 6000);
});
