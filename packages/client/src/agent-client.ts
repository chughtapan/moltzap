import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  Data,
  Deferred,
  Duration,
  Either,
  Effect,
  Exit,
  Fiber,
  ManagedRuntime,
  Option,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect";
import {
  PROTOCOL_VERSION,
  Connect,
  NotConnectedError,
  RpcTimeoutError,
  makeAgentClientConnection,
  type AgentClientConnection,
  type AnyNotificationDefinition,
  type DecodedNotification,
  type DecodedServerInbound,
  type NotificationParamsOf,
  type ParamsOf,
  type ResultOf,
  type RpcCallError,
  type RpcDefinition,
} from "@moltzap/protocol";
import { decodeFrames } from "./runtime/frame.js";
import {
  makeSubscriberRegistry,
  type SubscriberRegistry,
} from "./runtime/subscribers.js";
import {
  subscribe as subscribeStream,
  subscribeAll as subscribeAllStream,
} from "./notification/stream.js";
import { extractCloseInfo, type CloseInfo } from "./runtime/close-info.js";

export type { CloseInfo };

/** Default per-RPC timeout. */
const RPC_TIMEOUT_MS = 30_000;

export interface RpcCallOptions {
  readonly timeoutMs?: number;
}

type ConnectError = RpcCallError | RpcTimeoutError;

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_FACTOR = 2;
const NORMAL_CLOSE_CODE = 1000;
const WEB_SOCKET_OPEN_TIMEOUT_SECONDS = 10;
const MALFORMED_FRAME_PREVIEW_CHARS = 200;
const MALFORMED_LOG_EVERY = 50;

const shouldLogMalformedFrame = (count: number): boolean =>
  count === 1 || count % MALFORMED_LOG_EVERY === 0;

const MSG_NOT_CONNECTED = "WebSocket not connected";
const UTF8_DECODER = new TextDecoder("utf-8");

const makeNotConnectedError = (): NotConnectedError =>
  new NotConnectedError({ message: MSG_NOT_CONNECTED });

type ConnectResult = ResultOf<typeof Connect>;
type DecodedIncomingFrame = Effect.Effect.Success<
  ReturnType<typeof decodeFrames>
>[number];
type DecodedIncomingResponse = Extract<
  DecodedIncomingFrame,
  { readonly _tag: "ResponseSuccess" | "ResponseError" }
>;
type DecodedIncomingNotification = Extract<
  DecodedIncomingFrame,
  { readonly _tag: "Notification" }
>;
type DecodedServerRequest = Extract<
  DecodedServerInbound,
  { readonly _tag: "ServerRequest" }
>;

class ReconnectAttemptFailedError extends Data.TaggedError(
  "ReconnectAttemptFailedError",
)<{
  readonly reason: string;
}> {}

interface ConnState {
  readonly write: (
    chunk: string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly readerFiber: Fiber.RuntimeFiber<void, Socket.SocketError>;
  readonly scope: Scope.CloseableScope;
  readonly agentConn: AgentClientConnection;
  readonly handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>;
}

type ClientWebSocket = Effect.Effect.Success<
  ReturnType<typeof Socket.makeWebSocket>
>;

export interface AgentClientOptions {
  serverUrl: string;
  agentKey: string;
  onDisconnect?: (close: CloseInfo) => void;
  onReconnect?: (helloOk: ConnectResult) => void;
}

/**
 * MoltZap agent client — outbound RPC only, no TM-callback inbound
 * dispatch. `request` is narrowed to `AnyAgentClientRpcDefinition`; TM-only
 * methods are unreachable at compile time (Spec D3 R11/R13).
 */
export class MoltZapAgentClient {
  private readonly stateRef: Ref.Ref<Option.Option<ConnState>>;
  private readonly malformedRef: Ref.Ref<number>;
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Socket.WebSocketConstructor,
    never
  >;
  private readonly subscribers: SubscriberRegistry;
  private closed = false;
  private reconnectFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private _helloOk: ConnectResult | null = null;

  constructor(private readonly options: AgentClientOptions) {
    this.runtime = ManagedRuntime.make(NodeSocket.layerWebSocketConstructor);
    this.stateRef = this.runtime.runSync(
      Ref.make<Option.Option<ConnState>>(Option.none()),
    );
    this.malformedRef = this.runtime.runSync(Ref.make(0));
    this.subscribers = this.runtime.runSync(makeSubscriberRegistry());
  }

  get helloOk(): ConnectResult | null {
    return this._helloOk;
  }

  connect(): Effect.Effect<ConnectResult, ConnectError> {
    return this.runtime.runtimeEffect.pipe(
      Effect.flatMap(() => this.connectEffect()),
      Effect.provide(this.runtime),
    );
  }

  /**
   * Outbound RPC. The compile-time constraint accepts any
   * `RpcDefinition` so generic forwarders (service.sendRpc, CLI
   * transport) can pass through without per-method narrowing; the R11
   * agent-client catalog narrowing applies at runtime inside
   * `AgentClientConnection` and rejects TM-only methods.
   */
  sendRpc<D extends RpcDefinition<string, any, any>>(
    definition: D,
    params: ParamsOf<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ResultOf<D>, ConnectError> {
    const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
    return this.sendRpcEffect(definition, params, timeoutMs);
  }

  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<DecodedNotification<D>, NotConnectedError, never>;
  subscribe<
    D extends AnyNotificationDefinition,
    R extends NotificationParamsOf<D>,
  >(
    definition: D,
    refinement: (params: NotificationParamsOf<D>) => params is R,
  ): Stream.Stream<DecodedNotification<D, R>, NotConnectedError, never>;
  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    // eslint-disable-next-line agent-code-guard/no-conditional-chaining -- optional refinement is a value-level passthrough to the Stream factory; not a refinement-of-discriminant decision
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<DecodedNotification<D>, NotConnectedError, never> {
    return subscribeStream(this.subscribers, definition, refinement);
  }

  subscribeAll(
    // eslint-disable-next-line agent-code-guard/no-conditional-chaining -- optional refinement is a value-level passthrough to the Stream factory; not a refinement-of-discriminant decision
    refinement?: (
      notification: DecodedNotification<AnyNotificationDefinition>,
    ) => boolean,
  ): Stream.Stream<
    DecodedNotification<AnyNotificationDefinition>,
    NotConnectedError,
    never
  > {
    return subscribeAllStream(this.subscribers, refinement);
  }

  close(): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      if (this.closed) return;
      const hasCompletedHandshake = this._helloOk !== null;
      this.closed = true;
      this._helloOk = null;
      if (this.reconnectFiber !== null) {
        const f = this.reconnectFiber;
        this.reconnectFiber = null;
        yield* Effect.forkDaemon(Fiber.interrupt(f));
      }
      yield* this.failAllPending(MSG_NOT_CONNECTED);
      yield* this.subscribers.closeAll;
      const state = yield* Ref.getAndSet(this.stateRef, Option.none());
      if (Option.isSome(state)) {
        if (hasCompletedHandshake) {
          yield* state.value
            .write(new Socket.CloseEvent(NORMAL_CLOSE_CODE, "normal"))
            .pipe(Effect.orDie);
          yield* Scope.close(state.value.scope, Exit.void);
        } else {
          this.runtime.runFork(Scope.close(state.value.scope, Exit.void));
        }
      }
    }).pipe(
      Effect.asVoid,
      Effect.ensuring(
        Effect.sync(() => {
          this.runtime.dispose();
        }),
      ),
    );
  }

  disconnect(): Effect.Effect<void, never> {
    return Effect.sync(() => this.disconnectSync());
  }

  private disconnectSync(): void {
    const state = this.runtime.runSync(Ref.get(this.stateRef));
    if (Option.isNone(state)) return;
    this.runtime.runSync(Ref.set(this.stateRef, Option.none()));
    this.runtime.runFork(this.failConnectionPending(state.value));
    this.runtime.runFork(Fiber.interrupt(state.value.readerFiber));
    this.runtime.runFork(Scope.close(state.value.scope, Exit.void));
  }

  private notifyDisconnect(close: CloseInfo): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      try {
        this.options.onDisconnect?.(close);
      } catch (err) {
        yield* Effect.logWarning("onDisconnect handler threw", err);
      }
    });
  }

  private connectEffect(): Effect.Effect<
    ConnectResult,
    ConnectError,
    Socket.WebSocketConstructor
  > {
    return Effect.gen(this, function* () {
      const url = this.webSocketUrl();
      const scope = yield* Scope.make();
      const socket = yield* this.openSocket(url, scope);
      const write = yield* Scope.extend(socket.writer, scope);
      const agentConn = yield* Scope.extend(
        makeAgentClientConnection<never, never>({
          id: "agent-client",
          handlers: {},
          write: (raw) => write(raw),
          idPrefix: "rpc",
        }),
        scope,
      );
      const handshakeSettled = yield* Deferred.make<
        ConnectResult,
        ConnectError
      >();
      const readerFiber = this.runtime.runFork(
        this.readerEffect(socket, handshakeSettled),
      );

      yield* this.publishConnectionState({
        write,
        readerFiber,
        scope,
        agentConn,
        handshakeSettled,
      });
      return yield* this.awaitConnectAuth(handshakeSettled);
    });
  }

  private webSocketUrl(): string {
    return this.options.serverUrl.replace(/^http/, "ws") + "/ws";
  }

  private openSocket(
    url: string,
    scope: Scope.CloseableScope,
  ): Effect.Effect<
    ClientWebSocket,
    NotConnectedError,
    Socket.WebSocketConstructor
  > {
    const openTimeout = Duration.seconds(WEB_SOCKET_OPEN_TIMEOUT_SECONDS);
    return Scope.extend(Socket.makeWebSocket(url, { openTimeout }), scope).pipe(
      Effect.timeoutFail({
        duration: openTimeout,
        onTimeout: makeNotConnectedError,
      }),
      Effect.catchAllCause((cause) =>
        Effect.zipRight(
          Effect.logWarning("WebSocket open failed", cause),
          Effect.sync(() => {
            this.runtime.runFork(Scope.close(scope, Exit.void));
          }).pipe(Effect.zipRight(Effect.fail(makeNotConnectedError()))),
        ),
      ),
    );
  }

  private readerEffect(
    socket: ClientWebSocket,
    handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>,
  ): Effect.Effect<void, Socket.SocketError> {
    return socket
      .runRaw((data) =>
        this.handleIncoming(
          typeof data === "string" ? data : UTF8_DECODER.decode(data),
        ),
      )
      .pipe(
        Effect.onExit((exit) => this.handleReaderExit(exit, handshakeSettled)),
      );
  }

  private handleReaderExit(
    exit: Exit.Exit<void, Socket.SocketError>,
    handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (Exit.isFailure(exit)) {
        yield* Effect.logWarning("WebSocket error", exit.cause);
      }
      this._helloOk = null;
      yield* this.failAllPending(MSG_NOT_CONNECTED);
      yield* Deferred.fail(handshakeSettled, makeNotConnectedError()).pipe(
        Effect.ignore,
      );
      yield* Ref.set(this.stateRef, Option.none());
      yield* this.notifyDisconnect(extractCloseInfo(exit));
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private publishConnectionState(state: ConnState): Effect.Effect<void> {
    return Ref.set(this.stateRef, Option.some(state));
  }

  private awaitConnectAuth(
    handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>,
  ): Effect.Effect<ConnectResult, ConnectError> {
    const authEffect = this.sendRpc(Connect, {
      agentKey: this.options.agentKey,
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
    });
    return Effect.raceFirst(authEffect, Deferred.await(handshakeSettled)).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          this._helloOk = value;
        }),
      ),
    );
  }

  private sendRpcEffect<D extends RpcDefinition<string, any, any>>(
    definition: D,
    params: ParamsOf<D>,
    timeoutMs: number,
  ): Effect.Effect<ResultOf<D>, ConnectError> {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) {
        return yield* Effect.fail(makeNotConnectedError());
      }
      const call = state.value.agentConn.call as <
        D2 extends RpcDefinition<string, any, any>,
      >(
        definition: D2,
        params: ParamsOf<D2>,
      ) => Effect.Effect<ResultOf<D2>, ConnectError>;
      return yield* call(definition, params).pipe(
        Effect.timeoutFail({
          duration: `${timeoutMs} millis`,
          onTimeout: () =>
            new RpcTimeoutError({ method: definition.name, timeoutMs }),
        }),
      );
    });
  }

  private recordMalformedFrame(err: {
    readonly raw: string;
  }): Effect.Effect<null> {
    return Effect.gen(this, function* () {
      const count = yield* Ref.updateAndGet(this.malformedRef, (n) => n + 1);
      if (shouldLogMalformedFrame(count)) {
        yield* Effect.logWarning(`Malformed frame (#${count})`).pipe(
          Effect.annotateLogs({
            rawPreview: err.raw.slice(0, MALFORMED_FRAME_PREVIEW_CHARS),
          }),
        );
      }
      return null;
    });
  }

  private handleDecodedResponse(
    decoded: DecodedIncomingResponse,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) return;
      yield* state.value.agentConn.resolve(decoded.frame).pipe(Effect.asVoid);
    });
  }

  // Agent clients receive no inbound RPC; if a malicious or stray
  // ServerRequest arrives, log + drop.
  private handleDecodedServerRequest(
    decoded: DecodedServerRequest,
  ): Effect.Effect<void> {
    return Effect.logWarning(
      "AgentClient received unexpected ServerRequest",
    ).pipe(Effect.annotateLogs({ method: decoded.frame.method }));
  }

  private handleDecodedNotification(
    decoded: DecodedIncomingNotification,
  ): Effect.Effect<void> {
    return this.subscribers.dispatch(decoded);
  }

  private handleDecodedFrame(
    decoded: DecodedIncomingFrame,
  ): Effect.Effect<void> {
    switch (decoded._tag) {
      case "ResponseSuccess":
      case "ResponseError":
        return this.handleDecodedResponse(decoded);
      case "ServerRequest":
        return this.handleDecodedServerRequest(decoded);
      case "Notification":
        return this.handleDecodedNotification(decoded);
    }
  }

  private handleIncoming(raw: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const decodedFrames = yield* decodeFrames(raw).pipe(
        Effect.catchTag("MalformedFrameError", (err) =>
          this.recordMalformedFrame(err),
        ),
      );
      if (decodedFrames === null) return;
      for (const decoded of decodedFrames) {
        yield* this.handleDecodedFrame(decoded);
      }
    });
  }

  private failConnectionPending(state: ConnState): Effect.Effect<void> {
    return state.agentConn.failAllPending(
      new NotConnectedError({ message: MSG_NOT_CONNECTED }),
    );
  }

  private failAllPending(message: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) return;
      yield* state.value.agentConn.failAllPending(
        new NotConnectedError({ message }),
      );
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectFiber !== null) return;

    const attempt = this.connectEffect().pipe(
      Effect.tap((helloOk) =>
        Effect.gen(this, function* () {
          try {
            this.options.onReconnect?.(helloOk);
          } catch (err) {
            yield* Effect.logWarning("onReconnect handler threw", err);
          }
        }),
      ),
      Effect.either,
      Effect.flatMap(
        Either.match({
          onLeft: () =>
            Effect.fail(
              new ReconnectAttemptFailedError({
                reason: "reconnect attempt failed",
              }),
            ),
          onRight: (value) => Effect.succeed(value),
        }),
      ),
    );

    const backoff = Schedule.exponential(
      Duration.millis(BASE_RECONNECT_DELAY_MS),
      RECONNECT_BACKOFF_FACTOR,
    ).pipe(
      Schedule.either(Schedule.spaced(Duration.millis(MAX_RECONNECT_DELAY_MS))),
      Schedule.jittered,
    );

    const loop: Effect.Effect<void, never> = attempt.pipe(
      Effect.retry(backoff),
      Effect.asVoid,
      Effect.catchAll(() => Effect.void),
      Effect.ensuring(
        Effect.sync(() => {
          this.reconnectFiber = null;
        }),
      ),
      Effect.provide(NodeSocket.layerWebSocketConstructor),
    );

    this.reconnectFiber = this.runtime.runFork(loop);
  }
}
