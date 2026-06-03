/**
 * Unit tests for the task-callback (server→client) RPC test surface on `TestClient`:
 *
 *   - `onAppCallback(method, handler)` — registers a handler for a
 *     server-initiated request method.
 *   - `awaitServerRequest(method, predicate?, timeoutMs?)` — observes the
 *     inbound request payload (independent from handler dispatch).
 *
 * `dispatch/authorize` is the sole server→client awaitable descriptor;
 * every scenario uses it as the canonical task-callback RPC.
 *
 * Pattern: spin up an in-process `@effect/platform-node` WebSocket server
 * that scripts the task-callback traffic the test wants. `autoConnect: false`
 * skips the network/connect handshake — these tests exercise the
 * task-callback machinery directly without leaning on registered
 * server-core verbs.
 */
import { describe, it, expect } from "vitest";
import {
  Cause,
  Deferred,
  Effect,
  Either,
  Exit,
  Option,
  Ref,
  Schema,
  Scope,
} from "effect";
import { waitForValue } from "../wait.js";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Socket from "@effect/platform/Socket";
import {
  makeTestClient,
  type TestClient,
} from "../conformance/_shared/driver/test-client.js";
import { RpcResponseError } from "../conformance/_shared/errors.js";
import type { RequestFrame, ResponseFrame } from "../../transport/wire.js";
import { requestFrame, validateResponseFrame } from "../../transport/wire.js";
import type { ParamsOf, RpcDefinition } from "../../transport/method.js";

import { DispatchAuthorize } from "../../app/index.js";
import {
  agentId,
  conversationId,
  messageId,
  taskId as makeTaskId,
} from "../conformance/_shared/test-fixtures.js";

const TASK_ID = makeTaskId("550e8400-e29b-41d4-a716-446655440000");
const APP_ID = "test-app";
const CONVERSATION_ID = conversationId("550e8400-e29b-41d4-a716-446655440001");
const AGENT_ID = agentId("550e8400-e29b-41d4-a716-446655440002");
const MESSAGE_ID = messageId("550e8400-e29b-41d4-a716-446655440003");
const HOOK_AGENT = { agentId: AGENT_ID, ownerId: "owner-1" } as const;
const HANDLER_REJECTION_TAG = "Forbidden";
const METHOD_NOT_FOUND_TAG = "NotFound";
const SHORT_AWAIT_SERVER_REQUEST_TIMEOUT_MS = 50;
const GENEROUS_AWAIT_SERVER_REQUEST_TIMEOUT_MS = 60_000;
const DOMAIN_REJECTED_MESSAGE = "domain-rejected";
const CALL_SITE_TIMEOUT_MESSAGE = "call-site-timeout";

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

type ScriptedServerWriter = (
  raw: string | Uint8Array | Socket.CloseEvent,
) => Effect.Effect<void>;

const rawSocketDataToString = (data: string | Uint8Array): string =>
  typeof data === "string" ? data : new TextDecoder("utf-8").decode(data);

const appendReceivedData =
  (data: string | Uint8Array) =>
  (arr: ReadonlyArray<string>): ReadonlyArray<string> => [
    ...arr,
    rawSocketDataToString(data),
  ];

// The TestClient multiplexes the socket with a `{ ch, f }` envelope
// (`mux.ts`): it wraps every outbound frame and unwraps every inbound
// one. This scripted server mirrors that framing — record the inner frame so
// assertions read the bare JSON-RPC reply, and send server-originated callbacks
// wrapped on the `s2c` channel the client's reverse reader consumes.
const muxUnwrap = (raw: string): string => {
  const parsed = Either.getOrNull(Either.try(() => JSON.parse(raw) as unknown));
  if (typeof parsed !== "object" || parsed === null) return raw;
  const f = (parsed as { readonly f?: unknown }).f;
  return typeof f === "string" ? f : raw;
};

const muxWrapServerFrame = (frame: unknown): string =>
  JSON.stringify({ ch: "s2c", f: JSON.stringify(frame) });

const recordReceivedData = (
  receivedRef: Ref.Ref<ReadonlyArray<string>>,
  data: string | Uint8Array,
): Effect.Effect<void> => {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  return Ref.update(receivedRef, appendReceivedData(muxUnwrap(text)));
};

const ignoreWriterErrors =
  (
    write: (
      raw: string | Uint8Array | Socket.CloseEvent,
    ) => Effect.Effect<void, unknown>,
  ): ScriptedServerWriter =>
  (raw) =>
    write(raw).pipe(Effect.ignore);

/**
 * Bind a tiny WS server on `127.0.0.1:0` whose only job is to:
 *  - accept ONE inbound socket;
 *  - record every received frame on `received`;
 *  - expose `send` so the test scripts task-callback traffic.
 *
 * The server is owned by the surrounding `Scope`; closing the scope
 * shuts it down. There is no network/connect auto-reply — tests construct
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
  const onRawData = (data: string | Uint8Array) =>
    recordReceivedData(receivedRef, data);
  const connectedDef = yield* Deferred.make<void>();

  yield* Effect.forkScoped(
    server
      .run((sock) =>
        Effect.gen(function* () {
          const write = yield* sock.writer;
          yield* Ref.set(writerRef, ignoreWriterErrors(write));
          yield* Deferred.succeed(connectedDef, undefined).pipe(Effect.ignore);
          yield* sock.runRaw(onRawData);
        }),
      )
      .pipe(Effect.ignore),
  );

  const send: ScriptedServerHandle["send"] = (frame) =>
    Effect.gen(function* () {
      const writer = yield* Ref.get(writerRef);
      if (writer === null) return;
      yield* writer(muxWrapServerFrame(frame));
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
    agentId: AGENT_ID,
    defaultTimeoutMs: 2_000,
    captureCapacity: 64,
    autoConnect: false,
  }) as const;

const withClient = <A, E>(
  body: (
    client: TestClient,
    server: ScriptedServerHandle,
  ) => Effect.Effect<A, E>,
): Effect.Effect<A> =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* makeScriptedServer;
      const client = yield* makeTestClient(baseTestClientConfig(server.wsUrl));
      yield* server.connected;
      return yield* body(client, server);
    }),
  ).pipe(Effect.orDie);

const findResponse = (
  raw: ReadonlyArray<string>,
  id: string,
): ResponseFrame | undefined => {
  for (const r of raw) {
    const parsed: unknown = JSON.parse(r);
    if (
      validateResponseFrame(parsed) &&
      typeof parsed.id === "string" &&
      parsed.id === id
    ) {
      return parsed;
    }
  }
  return undefined;
};

const appCallbackRequest = <
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
>(
  id: string,
  definition: RpcDefinition<Name, P, R>,
  params: Schema.Schema.Type<P>,
): RequestFrame => requestFrame(id, definition, params);

function expectResponseResult(reply: ResponseFrame): unknown {
  expect("result" in reply).toBe(true);
  if (!("result" in reply)) throw new Error("expected response result");
  return reply.result;
}

function expectResponseError(reply: ResponseFrame): {
  readonly _tag: string;
  readonly message?: string;
  readonly data?: unknown;
} {
  expect("error" in reply).toBe(true);
  if (!("error" in reply)) throw new Error("expected response error");
  return reply.error;
}

const waitForResponse = (
  server: ScriptedServerHandle,
  id: string,
): Effect.Effect<ResponseFrame> =>
  waitForValue(
    server.received.pipe(Effect.map((raw) => findResponse(raw, id))),
  );

const validatingGrantHandler = (
  params: ParamsOf<typeof DispatchAuthorize>,
): Effect.Effect<ReturnType<typeof grantResult>> =>
  Effect.sync(() => {
    expect(params.taskId).toBe(TASK_ID);
    return grantResult();
  });

const dispatchesInboundTaskCallback = withClient((client, server) =>
  Effect.gen(function* () {
    yield* client.onAppCallback(DispatchAuthorize, validatingGrantHandler);
    yield* server.send(
      appCallbackRequest("srv-1", DispatchAuthorize, authorizeDispatchParams()),
    );
    const reply = yield* waitForResponse(server, "srv-1");
    expect(expectResponseResult(reply)).toEqual(grantResult());
  }),
);

const encodesTypedHandlerError = withClient((client, server) =>
  Effect.gen(function* () {
    yield* client.onAppCallback(DispatchAuthorize, () =>
      Effect.fail(
        new RpcResponseError({
          method: DispatchAuthorize.name,
          requestId: "srv-2",
          tag: HANDLER_REJECTION_TAG,
          message: DOMAIN_REJECTED_MESSAGE,
          data: { reason: "x" },
        }),
      ),
    );
    yield* server.send(
      appCallbackRequest("srv-2", DispatchAuthorize, authorizeDispatchParams()),
    );
    const reply = yield* waitForResponse(server, "srv-2");
    const error = expectResponseError(reply);
    expect(error._tag).toBe(HANDLER_REJECTION_TAG);
    expect(error.message).toBe(DOMAIN_REJECTED_MESSAGE);
    expect(error.data).toEqual({ reason: "x" });
  }),
);

const rejectsUnregisteredTaskCallback = withClient((_client, server) =>
  Effect.gen(function* () {
    yield* server.send(
      appCallbackRequest("srv-3", DispatchAuthorize, authorizeDispatchParams()),
    );
    const reply = yield* waitForResponse(server, "srv-3");
    const error = expectResponseError(reply);
    expect(error._tag).toBe(METHOD_NOT_FOUND_TAG);
    expect(error.message).toContain(DispatchAuthorize.name);
  }),
);

const replacesPriorTaskCallbackHandler = withClient((client, server) =>
  Effect.gen(function* () {
    yield* client.onAppCallback(DispatchAuthorize, () =>
      Effect.succeed(grantResult()),
    );
    yield* client.onAppCallback(DispatchAuthorize, () =>
      Effect.succeed(grantResult()),
    );
    yield* server.send(
      appCallbackRequest("srv-4", DispatchAuthorize, authorizeDispatchParams()),
    );
    const reply = yield* waitForResponse(server, "srv-4");
    expect(expectResponseResult(reply)).toEqual(grantResult());
  }),
);

const awaitsRequestAndRunsHandler = withClient((client, server) =>
  Effect.gen(function* () {
    yield* client.onAppCallback(DispatchAuthorize, validatingGrantHandler);
    const awaitFiber = yield* Effect.fork(
      client.awaitServerRequest(DispatchAuthorize),
    );
    yield* Effect.sleep("10 millis");
    yield* server.send(
      appCallbackRequest("srv-5", DispatchAuthorize, authorizeDispatchParams()),
    );

    const observed = yield* awaitFiber;
    expect(observed).toEqual(authorizeDispatchParams());

    const reply = yield* waitForResponse(server, "srv-5");
    expect(expectResponseResult(reply)).toEqual(grantResult());
  }),
);

const selectsFirstMatchingAwaitedRequest = withClient((client, server) =>
  Effect.gen(function* () {
    yield* client.onAppCallback(DispatchAuthorize, () =>
      Effect.succeed(grantResult()),
    );
    const wantedTaskId = makeTaskId("550e8400-e29b-41d4-a716-446655440099");
    const awaitFiber = yield* Effect.fork(
      client.awaitServerRequest(
        DispatchAuthorize,
        (p) => p.taskId === wantedTaskId,
      ),
    );
    yield* Effect.sleep("10 millis");
    yield* server.send(
      appCallbackRequest("srv-skip", DispatchAuthorize, {
        ...authorizeDispatchParams(
          makeTaskId("550e8400-e29b-41d4-a716-446655440098"),
        ),
      }),
    );
    yield* server.send(
      appCallbackRequest("srv-want", DispatchAuthorize, {
        ...authorizeDispatchParams(wantedTaskId),
      }),
    );

    const observed = yield* awaitFiber;
    expect(observed.taskId).toBe(wantedTaskId);
  }),
);

const callerSuppliedAwaitTimeout = withClient((client) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      client.awaitServerRequest(
        DispatchAuthorize,
        undefined,
        SHORT_AWAIT_SERVER_REQUEST_TIMEOUT_MS,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const failure = Option.getOrNull(Cause.failureOption(exit.cause));
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/Timeout.*dispatch\/authorize/);
  }),
);

const callSiteTimeoutOverridesDefault = withClient((client) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      client
        .awaitServerRequest(
          DispatchAuthorize,
          undefined,
          GENEROUS_AWAIT_SERVER_REQUEST_TIMEOUT_MS,
        )
        .pipe(
          Effect.timeoutFail({
            duration: "30 millis",
            onTimeout: () => new Error(CALL_SITE_TIMEOUT_MESSAGE),
          }),
        ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const failure = Option.getOrNull(Cause.failureOption(exit.cause));
    expect((failure as Error).message).toBe(CALL_SITE_TIMEOUT_MESSAGE);
  }),
);

describe("TestClient — onAppCallback success", () => {
  it("dispatches an inbound task-callback request to the registered handler and writes the response back", () => {
    expect.hasAssertions();
    return Effect.runPromise(dispatchesInboundTaskCallback);
  });

  it("registration ordering: a later onAppCallback replaces the prior handler", () => {
    expect.hasAssertions();
    return Effect.runPromise(replacesPriorTaskCallbackHandler);
  });
});

describe("TestClient — onAppCallback errors", () => {
  it("encodes a typed RpcResponseError from the handler as a `response` frame with `error`", () => {
    expect.hasAssertions();
    return Effect.runPromise(encodesTypedHandlerError);
  });

  it("rejects an unregistered method with -32601 (no handler)", () => {
    expect.hasAssertions();
    return Effect.runPromise(rejectsUnregisteredTaskCallback);
  });
});

describe("TestClient — awaitServerRequest matching", () => {
  it("resolves with the inbound request params and runs the handler in parallel", () => {
    expect.hasAssertions();
    return Effect.runPromise(awaitsRequestAndRunsHandler);
  });

  it("predicate selects the FIRST matching request and skips earlier non-matches", () => {
    expect.hasAssertions();
    return Effect.runPromise(selectsFirstMatchingAwaitedRequest);
  });
});

describe("TestClient — awaitServerRequest timeout", () => {
  it("times out with a typed Error after caller-supplied timeoutMs", () => {
    expect.hasAssertions();
    return Effect.runPromise(callerSuppliedAwaitTimeout);
  });

  it("respects an outer Effect.timeout wrapped at the call site", () => {
    expect.hasAssertions();
    return Effect.runPromise(callSiteTimeoutOverridesDefault);
  });
});
