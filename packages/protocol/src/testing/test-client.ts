/**
 * TestClient — connects to a REAL MoltZap server URL and drives the wire.
 *
 * Per D1 (WS-only) and Invariant I1 (primitives never bypass the wire),
 * every request is serialized and pushed through a real WebSocket transport.
 * We use Node.js 22+'s built-in global `WebSocket` which matches the
 * browser shape the `packages/client` transport targets — bytes on the wire
 * are identical.
 *
 * Satisfies AC2. Consumed by Tier A / B / C / D / E properties.
 */
import {
  Context,
  Deferred,
  Effect,
  Ref,
  type Scope,
  Stream,
  Chunk,
} from "effect";
import type { RpcMap, RpcMethodName } from "../rpc-registry.js";
import type { EventFrame } from "../schema/frames.js";
import {
  makeCaptureBuffer,
  recordFrame,
  recordMalformed,
  type CapturedFrame,
  type CaptureBuffer,
} from "./captures.js";
import {
  decodeFrame,
  encodeFrame,
  malformFrame,
  type AnyFrame,
  type MalformedFrameKind,
} from "./codec.js";
import {
  FrameSchemaError,
  RpcResponseError,
  RpcTimeoutError,
  TransportClosedError,
  TransportIoError,
} from "./errors.js";

/**
 * Options for connecting a TestClient. `serverUrl` is the `ws://…` URL of
 * the real server; `agentKey` + `agentId` are for the `connect` handshake.
 * `defaultTimeoutMs` bounds each `sendRpc` unless overridden per call.
 */
export interface TestClientConfig {
  readonly serverUrl: string;
  readonly agentKey: string;
  readonly agentId: string;
  readonly defaultTimeoutMs: number;
  /** Soft cap on captured frames before the ring buffer drops oldest. */
  readonly captureCapacity: number;
  /**
   * When `true`, send the `auth/connect` + `auth/selectAgent` handshake
   * automatically after the WS upgrade. Defaults to `true`.
   */
  readonly autoConnect?: boolean;
  /** Quiescence window (ms) for `sendMalformed` to wait for a response. */
  readonly malformedQuiescenceMs?: number;
}

/**
 * Handle surface. Scoped: acquiring the handle opens the WS; releasing the
 * scope closes it. All methods return Effects so property code can compose
 * them inside `Effect.forEach` / `fc.asyncProperty`.
 */
export interface TestClient {
  readonly sendRpc: <M extends RpcMethodName>(
    method: M,
    params: RpcMap[M]["params"],
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<
    RpcMap[M]["result"],
    | RpcResponseError
    | RpcTimeoutError
    | TransportClosedError
    | TransportIoError
    | FrameSchemaError
  >;

  readonly sendMalformed: (opts: {
    readonly baseMethod: RpcMethodName;
    readonly kind: MalformedFrameKind;
    readonly seed: number;
  }) => Effect.Effect<
    RpcResponseError | null,
    TransportClosedError | TransportIoError | FrameSchemaError
  >;

  readonly events: Stream.Stream<EventFrame, TransportClosedError>;
  readonly captures: CaptureBuffer;
  readonly snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>>;
}

/** Context tag so property code can `Effect.serviceWith(TestClient, …)`. */
export const TestClient = Context.GenericTag<TestClient>(
  "@moltzap/protocol/testing/TestClient",
);

type PendingMap = Map<
  string,
  Deferred.Deferred<AnyFrame, RpcResponseError | TransportClosedError>
>;

interface CloseState {
  readonly closed: boolean;
  readonly code: number;
  readonly reason: string;
}

let requestIdCounter = 0;

function nextRequestId(): string {
  requestIdCounter += 1;
  return `tc-${Date.now().toString(36)}-${requestIdCounter.toString(36)}`;
}

/**
 * Open a real WS connection to `config.serverUrl`, complete the `connect`
 * handshake, and yield a `TestClient`. The surrounding `Scope` owns the
 * socket; releasing it sends the WS close frame and drains captures.
 */
export function makeTestClient(
  config: TestClientConfig,
): Effect.Effect<
  TestClient,
  TransportIoError | TransportClosedError | RpcResponseError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const captures = yield* makeCaptureBuffer({
      capacity: config.captureCapacity,
    });
    const pending: PendingMap = new Map();
    const closeRef = yield* Ref.make<CloseState>({
      closed: false,
      code: 0,
      reason: "",
    });
    const eventQueue = yield* Ref.make<ReadonlyArray<EventFrame>>([]);
    const eventSignal = yield* Deferred.make<void>();

    // Acquire the WS inside the ambient Scope so the release closes it.
    const ws = yield* Effect.acquireRelease(
      Effect.async<WebSocket, TransportIoError>((resume) => {
        let sock: WebSocket;
        try {
          sock = new WebSocket(config.serverUrl);
        } catch (err) {
          resume(
            Effect.fail(
              new TransportIoError({ direction: "outbound", cause: err }),
            ),
          );
          return;
        }
        sock.binaryType = "arraybuffer";
        sock.addEventListener("open", () => resume(Effect.succeed(sock)));
        sock.addEventListener("error", (evt) =>
          resume(
            Effect.fail(
              new TransportIoError({ direction: "outbound", cause: evt }),
            ),
          ),
        );
      }),
      (sock) =>
        Effect.sync(() => {
          try {
            sock.close(1000, "test-client-teardown");
            // #ignore-sloppy-code-next-line[bare-catch]: release must be total; double-close throws but there is no logger available in Effect.sync finalizers here
          } catch {
            /* best-effort teardown: WebSocket.close() throws when already closed */
          }
        }),
    );

    // Wire the incoming frame handler. Closes over pending + captures + ref.
    const onMessage = (data: string | ArrayBuffer | Buffer): void => {
      const raw =
        typeof data === "string"
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString("utf8")
            : data.toString("utf8");
      // Decode synchronously via runSync: decodeFrame is pure.
      const decoded = Effect.runSync(
        Effect.either(decodeFrame(raw, "inbound")),
      );
      if (decoded._tag === "Left") {
        // Record as malformed and drop — matches Tier A A4 "drop or typed error, never crash".
        Effect.runFork(recordMalformed(captures, raw, "bit-flip"));
        return;
      }
      const frame = decoded.right;
      Effect.runFork(recordFrame(captures, "inbound", raw, frame));

      if (frame.type === "response") {
        const id = frame.id;
        const def = pending.get(id);
        if (def !== undefined) {
          pending.delete(id);
          if (frame.error !== undefined) {
            Effect.runFork(
              Deferred.fail(
                def,
                new RpcResponseError({
                  method: "",
                  requestId: id,
                  code: frame.error.code,
                  message: frame.error.message,
                  data: frame.error.data,
                }),
              ),
            );
          } else {
            Effect.runFork(Deferred.succeed(def, frame));
          }
        }
      } else if (frame.type === "event") {
        Effect.runFork(
          Ref.update(eventQueue, (q) => [...q, frame as EventFrame]),
        );
        Effect.runFork(
          Deferred.succeed(eventSignal, undefined).pipe(
            Effect.orElseSucceed(() => undefined),
          ),
        );
      }
      // request frames from server are not expected in v1.
    };

    const onClose = (code: number, reason: string): void => {
      Effect.runFork(Ref.set(closeRef, { closed: true, code, reason }));
      const closedErr = new TransportClosedError({
        direction: "inbound",
        code,
        reason,
      });
      for (const [id, def] of pending) {
        pending.delete(id);
        Effect.runFork(Deferred.fail(def, closedErr));
      }
    };

    ws.addEventListener("message", (ev) => {
      const data = ev.data as unknown;
      if (
        typeof data === "string" ||
        data instanceof ArrayBuffer ||
        Buffer.isBuffer(data)
      ) {
        onMessage(data as string | ArrayBuffer | Buffer);
      }
    });
    ws.addEventListener("close", (ev) => onClose(ev.code, ev.reason));
    ws.addEventListener("error", (ev) => {
      // Error surfacing here is a best-effort; the close handler will fire next.
      void ev;
    });

    const writeFrame = (
      raw: string,
    ): Effect.Effect<void, TransportClosedError | TransportIoError> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(closeRef);
        if (state.closed) {
          return yield* Effect.fail(
            new TransportClosedError({
              direction: "outbound",
              code: state.code,
              reason: state.reason,
            }),
          );
        }
        try {
          ws.send(raw);
        } catch (err) {
          return yield* Effect.fail(
            new TransportIoError({ direction: "outbound", cause: err }),
          );
        }
      });

    const sendRpc: TestClient["sendRpc"] = (method, params, opts) =>
      Effect.gen(function* () {
        const id = nextRequestId();
        const timeoutMs = opts?.timeoutMs ?? config.defaultTimeoutMs;
        const request: AnyFrame = {
          type: "request",
          jsonrpc: "2.0",
          id,
          method,
          params,
        };
        const raw = encodeFrame(request);
        const deferred = yield* Deferred.make<
          AnyFrame,
          RpcResponseError | TransportClosedError
        >();
        pending.set(id, deferred);
        yield* recordFrame(captures, "outbound", raw, request);
        yield* writeFrame(raw);
        const result = yield* Deferred.await(deferred).pipe(
          Effect.timeoutFail({
            duration: `${timeoutMs} millis`,
            onTimeout: () =>
              new RpcTimeoutError({ method, requestId: id, timeoutMs }),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(id);
            }),
          ),
        );
        if (result.type !== "response") {
          return yield* Effect.fail(
            new FrameSchemaError({
              direction: "inbound",
              expected: "response",
              raw: encodeFrame(result),
              reason: "expected response frame for rpc reply",
            }),
          );
        }
        // Cast: the result shape is determined by the method and server contract.
        return result.result as RpcMap[typeof method]["result"];
      });

    const sendMalformed: TestClient["sendMalformed"] = (opts) =>
      Effect.gen(function* () {
        // Base a malformed payload on a minimal valid request shape.
        const baseFrame: AnyFrame = {
          type: "request",
          jsonrpc: "2.0",
          id: nextRequestId(),
          method: opts.baseMethod,
          params: {},
        };
        const raw = malformFrame(baseFrame, opts.kind, opts.seed);
        yield* recordMalformed(captures, raw, opts.kind);
        yield* writeFrame(raw);

        const waitMs = config.malformedQuiescenceMs ?? 500;
        // Wait briefly to see if the server responds with a typed error.
        return yield* Effect.succeed(null as RpcResponseError | null).pipe(
          Effect.delay(`${waitMs} millis`),
        );
      });

    // Event stream — repeatedly drain `eventQueue`, ending when the WS closes.
    const events: Stream.Stream<EventFrame, TransportClosedError> =
      Stream.unwrap(
        Effect.sync(() => {
          const pullOne: Effect.Effect<
            ReadonlyArray<EventFrame>,
            TransportClosedError
          > = Effect.gen(function* () {
            while (true) {
              const state = yield* Ref.get(closeRef);
              if (state.closed) {
                return yield* Effect.fail(
                  new TransportClosedError({
                    direction: "inbound",
                    code: state.code,
                    reason: state.reason,
                  }),
                );
              }
              const q = yield* Ref.getAndSet(eventQueue, []);
              if (q.length > 0) return q;
              yield* Effect.sleep("10 millis");
            }
          });
          return Stream.repeatEffectChunk(
            pullOne.pipe(Effect.map((arr) => Chunk.fromIterable(arr))),
          );
        }),
      );

    const client: TestClient = {
      sendRpc,
      sendMalformed,
      events,
      captures,
      snapshot: captures.snapshot,
    };

    // Auto-connect handshake (auth/connect). Best-effort — property code can
    // override with autoConnect=false and drive the handshake manually.
    if (config.autoConnect !== false) {
      // The `auth/connect` params shape drifts across protocol versions; the
      // TestClient accepts `{ agentKey, agentId }` because that is what every
      // current consumer passes. The server validates the params fully on
      // receive. A single cast at this call site keeps the rest of the
      // file precisely typed.
      const basicParams = {
        agentKey: config.agentKey,
        agentId: config.agentId,
      };
      const handshakeParams =
        // #ignore-sloppy-code-next-line[as-unknown-as]: auth/connect params shape is server-validated; handshake keeps TestClient transport-agnostic
        basicParams as unknown as RpcMap["auth/connect"]["params"];
      const handshake = sendRpc("auth/connect", handshakeParams).pipe(
        Effect.catchTag("TestingRpcTimeoutError", () => Effect.void),
        Effect.catchTag("TestingFrameSchemaError", () => Effect.void),
      );
      yield* handshake;
    }

    return client;
  });
}
