/**
 * Unit tests for the task-callback (server→client) RPC test surface on `TestClient`:
 *
 *   - `handleServerRpc(method, handler)` — registers a handler for a
 *     server-initiated request method.
 *   - `awaitServerRequest(method, predicate?, timeoutMs?)` — observes the
 *     inbound request payload (independent from handler dispatch).
 *
 * Phase 9b consumer-migration (sub-issue #460): the legacy `apps/onClose`,
 * `apps/onSessionActive`, `apps/onBeforeMessageDelivery`, `apps/onBeforeDispatch`
 * verbs retired. Only `task/authorizeDispatch` survives; every scenario
 * uses it as the canonical server→client awaitable RPC.
 *
 * Pattern: spin up an in-process `@effect/platform-node` WebSocket server
 * that scripts the task-callback traffic the test wants. `autoConnect: false`
 * skips the auth/connect handshake — these tests exercise the
 * task-callback machinery directly without leaning on registered
 * server-core verbs.
 */
import { describe, it, expect } from "vitest";
import { Cause, Deferred, Effect, Exit, Ref, Scope } from "effect";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Socket from "@effect/platform/Socket";
import { makeTestClient, type TestClient } from "../test-client.js";
import { RpcResponseError } from "../errors.js";
import type { RequestFrame, ResponseFrame } from "../../schema/frames.js";
import { requestFrame } from "../../helpers.js";
import { jsonRpcStringId } from "../../schema/json-rpc.js";
import { validators } from "../../validators.js";
import type { AnyTaskCallbackRpcDefinition } from "../../rpc-registry.js";
import type { ParamsOf } from "../../rpc.js";

import { TaskAuthorizeDispatch } from "../../app/methods/apps.js";
import {
  agentId,
  conversationId,
  messageId,
  taskId as makeTaskId,
} from "../../schema/primitives.js";

const TASK_ID = makeTaskId("550e8400-e29b-41d4-a716-446655440000");
const APP_ID = "test-app";
const CONVERSATION_ID = conversationId("550e8400-e29b-41d4-a716-446655440001");
const AGENT_ID = agentId("550e8400-e29b-41d4-a716-446655440002");
const MESSAGE_ID = messageId("550e8400-e29b-41d4-a716-446655440003");
const HOOK_AGENT = { agentId: AGENT_ID, ownerId: "owner-1" } as const;

const authorizeDispatchParams = (taskId = TASK_ID) => ({
  taskId,
  appId: APP_ID,
  conversationId: CONVERSATION_ID,
  recipient: HOOK_AGENT,
  message: {
    id: MESSAGE_ID,
    senderAgentId: AGENT_ID,
    parts: [{ type: "text" as const, text: "hi" }],
  },
  attempt: 0,
});

const grantResult = (): { admission: { decision: "grant" } } => ({
  admission: { decision: "grant" },
});

interface ScriptedServerHandle {
  readonly wsUrl: string;
  /** Push an arbitrary frame to the connected client. */
  readonly send: (frame: unknown) => Effect.Effect<void>;
  /**
   * Resolve once the client opens the WS. Useful so a test can sequence
   * "send task-callback" after the socket has come up but before any
   * other traffic.
   */
  readonly connected: Effect.Effect<void>;
  /** All raw frames the server has received, in order. */
  readonly received: Effect.Effect<ReadonlyArray<string>>;
}

/**
 * Bind a tiny WS server on `127.0.0.1:0` whose only job is to:
 *  - accept ONE inbound socket;
 *  - record every received frame on `received`;
 *  - expose `send` so the test scripts task-callback traffic.
 *
 * The server is owned by the surrounding `Scope`; closing the scope
 * shuts it down. There is no auth/connect auto-reply — tests construct
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
    ).pipe(Effect.orDie),
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
      validators.responseFrame(parsed) &&
      typeof parsed.id === "string" &&
      parsed.id === id
    ) {
      return parsed;
    }
  }
  return undefined;
};

const appCallbackRequest = <D extends AnyTaskCallbackRpcDefinition>(
  id: string,
  definition: D,
  params: ParamsOf<D>,
): RequestFrame => requestFrame(jsonRpcStringId(id), definition, params);

function expectResponseResult(reply: ResponseFrame): unknown {
  expect("result" in reply).toBe(true);
  if (!("result" in reply)) throw new Error("expected response result");
  return reply.result;
}

function expectResponseError(reply: ResponseFrame): {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
} {
  expect("error" in reply).toBe(true);
  if (!("error" in reply)) throw new Error("expected response error");
  return reply.error;
}

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
  it("dispatches an inbound task-callback request to the registered handler and writes the response back", async () => {
    await withClient((client, server) =>
      Effect.gen(function* () {
        yield* client.handleServerRpc(TaskAuthorizeDispatch, (params) =>
          Effect.sync(() => {
            expect(params.taskId).toBe(TASK_ID);
            return grantResult();
          }),
        );
        yield* server.send(
          appCallbackRequest(
            "srv-1",
            TaskAuthorizeDispatch,
            authorizeDispatchParams(),
          ),
        );
        const reply = yield* waitForResponse(server, "srv-1");
        expect(expectResponseResult(reply)).toEqual(grantResult());
      }),
    );
  });

  it("encodes a typed RpcResponseError from the handler as a `response` frame with `error`", async () => {
    await withClient((client, server) =>
      Effect.gen(function* () {
        yield* client.handleServerRpc(TaskAuthorizeDispatch, () =>
          Effect.fail(
            new RpcResponseError({
              method: TaskAuthorizeDispatch.name,
              requestId: "srv-2",
              code: -32099,
              message: "domain-rejected",
              data: { reason: "x" },
            }),
          ),
        );
        yield* server.send(
          appCallbackRequest(
            "srv-2",
            TaskAuthorizeDispatch,
            authorizeDispatchParams(),
          ),
        );
        const reply = yield* waitForResponse(server, "srv-2");
        const error = expectResponseError(reply);
        expect(error.code).toBe(-32099);
        expect(error.message).toBe("domain-rejected");
        expect(error.data).toEqual({ reason: "x" });
      }),
    );
  });

  it("rejects an unregistered method with -32601 (no handler)", async () => {
    await withClient((_client, server) =>
      Effect.gen(function* () {
        yield* server.send(
          appCallbackRequest(
            "srv-3",
            TaskAuthorizeDispatch,
            authorizeDispatchParams(),
          ),
        );
        const reply = yield* waitForResponse(server, "srv-3");
        const error = expectResponseError(reply);
        expect(error.code).toBe(-32601);
        expect(error.message).toContain(TaskAuthorizeDispatch.name);
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
        yield* client.handleServerRpc(TaskAuthorizeDispatch, () =>
          Effect.succeed(grantResult()),
        );
        yield* client.handleServerRpc(TaskAuthorizeDispatch, () =>
          Effect.succeed(grantResult()),
        );
        yield* server.send(
          appCallbackRequest(
            "srv-4",
            TaskAuthorizeDispatch,
            authorizeDispatchParams(),
          ),
        );
        const reply = yield* waitForResponse(server, "srv-4");
        expect(expectResponseResult(reply)).toEqual(grantResult());
      }),
    );
  });
});

describe("TestClient — awaitServerRequest", () => {
  it("resolves with the inbound request params and runs the handler in parallel", async () => {
    await withClient((client, server) =>
      Effect.gen(function* () {
        yield* client.handleServerRpc(TaskAuthorizeDispatch, (params) =>
          Effect.sync(() => {
            expect(params.taskId).toBe(TASK_ID);
            return grantResult();
          }),
        );
        // Set up the awaiter BEFORE sending the request — the awaiter
        // notification fires from `notifyAwaiters` during `handleInbound`,
        // which runs synchronously per inbound frame.
        const awaitFiber = yield* Effect.fork(
          client.awaitServerRequest(TaskAuthorizeDispatch),
        );
        // Tiny yield so the awaiter has a chance to enrol.
        yield* Effect.sleep("10 millis");
        yield* server.send(
          appCallbackRequest(
            "srv-5",
            TaskAuthorizeDispatch,
            authorizeDispatchParams(),
          ),
        );

        const observed = yield* awaitFiber;
        expect(observed).toEqual(authorizeDispatchParams());

        // Handler still ran — server saw the response.
        const reply = yield* waitForResponse(server, "srv-5");
        expect(expectResponseResult(reply)).toEqual(grantResult());
      }),
    );
  });

  it("predicate selects the FIRST matching request and skips earlier non-matches", async () => {
    await withClient((client, server) =>
      Effect.gen(function* () {
        yield* client.handleServerRpc(TaskAuthorizeDispatch, () =>
          Effect.succeed(grantResult()),
        );
        const wantedTaskId = makeTaskId("550e8400-e29b-41d4-a716-446655440099");
        // Predicate matches taskId === wantedTaskId.
        const awaitFiber = yield* Effect.fork(
          client.awaitServerRequest(
            TaskAuthorizeDispatch,
            (p) => p.taskId === wantedTaskId,
          ),
        );
        yield* Effect.sleep("10 millis");
        // Send a non-matching request first.
        yield* server.send(
          appCallbackRequest("srv-skip", TaskAuthorizeDispatch, {
            ...authorizeDispatchParams(
              makeTaskId("550e8400-e29b-41d4-a716-446655440098"),
            ),
          }),
        );
        // Then the wanted one.
        yield* server.send(
          appCallbackRequest("srv-want", TaskAuthorizeDispatch, {
            ...authorizeDispatchParams(wantedTaskId),
          }),
        );

        const observed = yield* awaitFiber;
        expect(observed.taskId).toBe(wantedTaskId);
      }),
    );
  });

  it("times out with a typed Error after caller-supplied timeoutMs", async () => {
    const exit = await withClient((client) =>
      Effect.gen(function* () {
        // Caller-controlled timeout. No task-callback request is ever
        // sent — the awaiter must terminate by the timeout, not hang.
        return yield* Effect.exit(
          client.awaitServerRequest(TaskAuthorizeDispatch, undefined, 50),
        );
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const opt = Cause.failureOption(exit.cause);
      expect(opt._tag).toBe("Some");
      if (opt._tag === "Some") {
        expect(opt.value).toBeInstanceOf(Error);
        expect(opt.value.message).toMatch(/Timeout.*task\/authorizeDispatch/);
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
          client
            .awaitServerRequest(TaskAuthorizeDispatch, undefined, 60_000)
            .pipe(
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
