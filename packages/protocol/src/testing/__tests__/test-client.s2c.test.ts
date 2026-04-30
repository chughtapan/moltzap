/**
 * Unit tests for the s2c (server→client) RPC test surface on `TestClient`:
 *
 *   - `handleServerRpc(method, handler)` — registers a handler for a
 *     server-initiated request method.
 *   - `awaitServerRequest(method, predicate?, timeoutMs?)` — observes the
 *     inbound request payload (independent from handler dispatch).
 *
 * Implementation lives in `../test-client.ts`. Architect plan §3.6
 * (chughtapan/moltzap#286 comment-4356088436) covers acceptance for B.7.
 *
 * Pattern: spin up an in-process `@effect/platform-node` WebSocket server
 * that scripts the s2c traffic the test wants. `autoConnect: false` skips
 * the auth/connect handshake — these tests exercise the s2c machinery
 * directly without leaning on registered server-core verbs (which don't
 * exist yet in Phase 1.0; B.2 lands the first ones).
 */
import { describe, it, expect } from "vitest";
import { Cause, Deferred, Effect, Exit, Ref, Scope } from "effect";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Socket from "@effect/platform/Socket";
import { makeTestClient, type TestClient } from "../test-client.js";
import { RpcResponseError } from "../errors.js";
import type { RequestFrame, ResponseFrame } from "../../schema/frames.js";

interface ScriptedServerHandle {
  readonly wsUrl: string;
  /** Push an arbitrary frame to the connected client. */
  readonly send: (frame: unknown) => Effect.Effect<void>;
  /**
   * Resolve once the client opens the WS. Useful so a test can sequence
   * "send s2c" after the socket has come up but before any other
   * traffic.
   */
  readonly connected: Effect.Effect<void>;
  /** All raw frames the server has received, in order. */
  readonly received: Effect.Effect<ReadonlyArray<string>>;
}

/**
 * Bind a tiny WS server on `127.0.0.1:0` whose only job is to:
 *  - accept ONE inbound socket;
 *  - record every received frame on `received`;
 *  - expose `send` so the test scripts s2c traffic.
 *
 * The server is owned by the surrounding `Scope`; closing the scope shuts
 * it down. There is no auth/connect auto-reply — tests construct
 * TestClient with `autoConnect: false`.
 */
const makeScriptedServer: Effect.Effect<
  ScriptedServerHandle,
  unknown,
  Scope.Scope
> = Effect.gen(function* () {
  const server = yield* NodeSocketServer.makeWebSocket({
    port: 0,
    host: "127.0.0.1",
  });
  const addr = server.address;
  if (addr._tag !== "TcpAddress") {
    return yield* Effect.die("expected TcpAddress");
  }
  const writerRef = yield* Ref.make<
    | ((raw: string | Uint8Array | Socket.CloseEvent) => Effect.Effect<void>)
    | null
  >(null);
  const receivedRef = yield* Ref.make<ReadonlyArray<string>>([]);
  const connectedDef = yield* Deferred.make<void>();

  yield* Effect.forkScoped(
    server
      .run((sock) =>
        Effect.gen(function* () {
          const write = yield* sock.writer;
          yield* Ref.set(writerRef, (raw) => write(raw).pipe(Effect.ignore));
          yield* Deferred.succeed(connectedDef, undefined).pipe(Effect.ignore);
          yield* sock.runRaw((data) =>
            Ref.update(receivedRef, (arr) => [
              ...arr,
              typeof data === "string"
                ? data
                : new TextDecoder("utf-8").decode(data),
            ]),
          );
        }),
      )
      .pipe(Effect.ignore),
  );

  const send: ScriptedServerHandle["send"] = (frame) =>
    Effect.gen(function* () {
      const writer = yield* Ref.get(writerRef);
      if (writer === null) return;
      yield* writer(JSON.stringify(frame));
    });

  return {
    wsUrl: `http://${addr.hostname}:${addr.port}`,
    send,
    connected: Deferred.await(connectedDef),
    received: Ref.get(receivedRef),
  };
});

const baseTestClientConfig = (wsUrl: string) =>
  ({
    serverUrl: wsUrl,
    agentKey: "test-key",
    agentId: "test-agent",
    defaultTimeoutMs: 2_000,
    captureCapacity: 64,
    autoConnect: false,
  }) as const;

const withClient = <A>(
  body: (client: TestClient, server: ScriptedServerHandle) => Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeScriptedServer;
        const client = yield* makeTestClient(
          baseTestClientConfig(server.wsUrl),
        );
        yield* server.connected;
        return yield* body(client, server);
      }),
    ) as Effect.Effect<A>,
  );

const findResponse = (
  raw: ReadonlyArray<string>,
  id: string,
): ResponseFrame | undefined => {
  for (const r of raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "response" &&
      (parsed as { id?: unknown }).id === id
    ) {
      return parsed as ResponseFrame;
    }
  }
  return undefined;
};

const s2cRequest = (
  id: string,
  method: string,
  params: unknown,
): RequestFrame =>
  ({
    type: "request",
    jsonrpc: "2.0",
    direction: "s2c",
    id,
    method,
    params,
  }) as RequestFrame;

const waitForResponse = (
  server: ScriptedServerHandle,
  id: string,
  maxMs = 2_000,
): Effect.Effect<ResponseFrame> =>
  Effect.gen(function* () {
    const deadline = Date.now() + maxMs;
    while (true) {
      const raw = yield* server.received;
      const found = findResponse(raw, id);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        return yield* Effect.die(
          new Error(`waitForResponse timeout for id=${id}`),
        );
      }
      yield* Effect.sleep("10 millis");
    }
  });

describe("TestClient — handleServerRpc", () => {
  it("dispatches an inbound s2c request to the registered handler and writes the response back", async () => {
    await withClient((client, server) =>
      Effect.gen(function* () {
        yield* client.handleServerRpc("apps/onJoin", (params) =>
          Effect.succeed({
            ack: true,
            saw: (params as { sessionId: string }).sessionId,
          }),
        );
        yield* server.send(
          s2cRequest("srv-1", "apps/onJoin", { sessionId: "S" }),
        );
        const reply = yield* waitForResponse(server, "srv-1");
        expect(reply.direction).toBe("s2c");
        expect(reply.error).toBeUndefined();
        expect(reply.result).toEqual({ ack: true, saw: "S" });
      }),
    );
  });

  it("encodes a typed RpcResponseError from the handler as a `response` frame with `error`", async () => {
    await withClient((client, server) =>
      Effect.gen(function* () {
        yield* client.handleServerRpc("apps/onClose", () =>
          Effect.fail(
            new RpcResponseError({
              method: "apps/onClose",
              requestId: "srv-2",
              code: -32099,
              message: "domain-rejected",
              data: { reason: "x" },
            }),
          ),
        );
        yield* server.send(s2cRequest("srv-2", "apps/onClose", {}));
        const reply = yield* waitForResponse(server, "srv-2");
        expect(reply.error).toBeDefined();
        expect(reply.error?.code).toBe(-32099);
        expect(reply.error?.message).toBe("domain-rejected");
        expect(reply.error?.data).toEqual({ reason: "x" });
        expect(reply.result).toBeUndefined();
      }),
    );
  });

  it("rejects an unregistered method with -32601 (no handler)", async () => {
    await withClient((_client, server) =>
      Effect.gen(function* () {
        yield* server.send(
          s2cRequest("srv-3", "apps/onSessionActive", { foo: 1 }),
        );
        const reply = yield* waitForResponse(server, "srv-3");
        expect(reply.error).toBeDefined();
        expect(reply.error?.code).toBe(-32601);
        expect(reply.error?.message).toContain("apps/onSessionActive");
      }),
    );
  });

  it("registration ordering: a later handleServerRpc replaces the prior handler", async () => {
    await withClient((client, server) =>
      Effect.gen(function* () {
        // Both registrations target the same method. The second wins —
        // TestClient deliberately differs from the production
        // `MoltZapWsClient.handleServerRpc`, which raises
        // `DuplicateServerRpcHandlerError`. Tests routinely swap handler
        // bodies mid-scenario.
        yield* client.handleServerRpc("apps/onJoin", () =>
          Effect.succeed({ winner: "first" }),
        );
        yield* client.handleServerRpc("apps/onJoin", () =>
          Effect.succeed({ winner: "second" }),
        );
        yield* server.send(s2cRequest("srv-4", "apps/onJoin", {}));
        const reply = yield* waitForResponse(server, "srv-4");
        expect(reply.result).toEqual({ winner: "second" });
      }),
    );
  });
});

describe("TestClient — awaitServerRequest", () => {
  it("resolves with the inbound request params and runs the handler in parallel", async () => {
    await withClient((client, server) =>
      Effect.gen(function* () {
        yield* client.handleServerRpc("apps/onJoin", (params) =>
          Effect.succeed({ saw: (params as { sessionId: string }).sessionId }),
        );
        // Set up the awaiter BEFORE sending the request — the awaiter
        // notification fires from `notifyAwaiters` during `handleInbound`,
        // which runs synchronously per inbound frame.
        const awaitFiber = yield* Effect.fork(
          client.awaitServerRequest("apps/onJoin"),
        );
        // Tiny yield so the awaiter has a chance to enrol.
        yield* Effect.sleep("10 millis");
        yield* server.send(
          s2cRequest("srv-5", "apps/onJoin", { sessionId: "Z" }),
        );

        const observed = yield* awaitFiber;
        expect(observed).toEqual({ sessionId: "Z" });

        // Handler still ran — server saw the response.
        const reply = yield* waitForResponse(server, "srv-5");
        expect(reply.result).toEqual({ saw: "Z" });
      }),
    );
  });

  it("predicate selects the FIRST matching request and skips earlier non-matches", async () => {
    await withClient((client, server) =>
      Effect.gen(function* () {
        yield* client.handleServerRpc("apps/onJoin", () => Effect.succeed({}));
        // Predicate matches sessionId === "WANTED".
        const awaitFiber = yield* Effect.fork(
          client.awaitServerRequest(
            "apps/onJoin",
            (p) => (p as { sessionId?: string }).sessionId === "WANTED",
          ),
        );
        yield* Effect.sleep("10 millis");
        // Send a non-matching request first.
        yield* server.send(
          s2cRequest("srv-skip", "apps/onJoin", { sessionId: "OTHER" }),
        );
        // Then the wanted one.
        yield* server.send(
          s2cRequest("srv-want", "apps/onJoin", { sessionId: "WANTED" }),
        );

        const observed = yield* awaitFiber;
        expect((observed as { sessionId: string }).sessionId).toBe("WANTED");
      }),
    );
  });

  it("times out with a typed Error after caller-supplied timeoutMs", async () => {
    const exit = await withClient((client) =>
      Effect.gen(function* () {
        // Caller-controlled timeout. No s2c request is ever sent — the
        // awaiter must terminate by the timeout, not hang.
        return yield* Effect.exit(
          client.awaitServerRequest("apps/onJoin", undefined, 50),
        );
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const opt = Cause.failureOption(exit.cause);
      expect(opt._tag).toBe("Some");
      if (opt._tag === "Some") {
        expect(opt.value).toBeInstanceOf(Error);
        expect(opt.value.message).toMatch(/Timeout.*apps\/onJoin/);
      }
    }
  });

  it("respects an outer Effect.timeout wrapped at the call site (overrides built-in default)", async () => {
    const exit = await withClient((client) =>
      Effect.gen(function* () {
        // Pass a generous internal timeout, then gate at the call site
        // with a tighter Effect.timeout. The architect plan §3.6 names
        // this as the supported pattern: "Effect.timeout at call site,
        // not schema cap."
        return yield* Effect.exit(
          client.awaitServerRequest("apps/onJoin", undefined, 60_000).pipe(
            Effect.timeoutFail({
              duration: "30 millis",
              onTimeout: () => new Error("call-site-timeout"),
            }),
          ),
        );
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const opt = Cause.failureOption(exit.cause);
      expect(opt._tag).toBe("Some");
      if (opt._tag === "Some") {
        expect(opt.value.message).toBe("call-site-timeout");
      }
    }
  });
});
