import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Mailbox,
  ManagedRuntime,
  Option,
  Ref,
  Scope,
  Stream,
} from "effect";
import { type RpcGroup } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import {
  PROTOCOL_VERSION,
  AgentCallableGroup,
  Connect,
  NotConnectedError,
  RpcTimeoutError,
  type AnyNotificationDefinition,
  type DecodedNotification,
  type NotificationParamsOf,
  type ResultOf,
} from "@moltzap/protocol";
import { buildNativeClient } from "./runtime/native-mux-client.js";
import {
  dispatchCall,
  type TypedDispatchMap,
  type PayloadForTag,
  type SuccessForTag,
  type ErrorForTag,
} from "./runtime/typed-dispatch.js";
import { buildReverseServer } from "./runtime/reverse-rpc-server.js";
import { runMuxReader } from "@moltzap/protocol";
import {
  makeSubscriberRegistry,
  type SubscriberRegistry,
} from "./runtime/subscribers.js";
import {
  subscribe as subscribeStream,
  subscribeAll as subscribeAllStream,
} from "./notification/stream.js";
import { extractCloseInfo, type CloseInfo } from "./runtime/close-info.js";
import {
  NORMAL_CLOSE_CODE,
  makeNotConnectedError,
  makeReconnectLoop,
  openSocket,
  webSocketUrl,
  type ClientWebSocket,
} from "./runtime/reconnect.js";

export type { CloseInfo };

/** Default per-RPC timeout. */
const RPC_TIMEOUT_MS = 30_000;

/**
 * The moderator-callback handlers for an agent client's reverse `RpcServer`. An
 * agent is never a moderator, so the three callback methods
 * (`dispatch/authorize`, `messages/authorize`, `task/create`) are never fired
 * at it — but the reverse handler map must cover every `ReverseRpcGroup`
 * member, so each rejects as an impossible-state defect.
 */
const makeAgentCallbackHandlers = (): Record<
  string,
  (params: unknown) => Effect.Effect<unknown, unknown>
> => {
  const reject = (method: string) => () =>
    Effect.dieMessage(`agent client received unexpected callback ${method}`);
  return {
    "dispatch/authorize": reject("dispatch/authorize"),
    "messages/authorize": reject("messages/authorize"),
    "task/create": reject("task/create"),
  };
};

export interface RpcCallOptions {
  readonly timeoutMs?: number;
}

type ConnectResult = ResultOf<typeof Connect>;

/** The agent group's member `Rpc`s — the tag-keyed dispatch surface. */
type AgentCallableRpcs = RpcGroup.Rpcs<typeof AgentCallableGroup>;

/** The branded wire tags the agent client may originate. */
type AgentCallableTag = AgentCallableRpcs["_tag"];

/** The handshake's error channel: `network/connect`'s errors plus transport. */
type ConnectError = Effect.Effect.Error<ReturnType<MoltZapAgentClient["call"]>>;

interface ConnState {
  readonly write: (
    chunk: string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly readerFiber: Fiber.RuntimeFiber<void, Socket.SocketError>;
  readonly scope: Scope.CloseableScope;
  readonly client: TypedDispatchMap<AgentCallableRpcs, RpcClientError>;
  readonly handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>;
}

export interface AgentClientOptions {
  serverUrl: string;
  agentKey: string;
  onDisconnect?: (close: CloseInfo) => void;
  onReconnect?: (helloOk: ConnectResult) => void;
}

/**
 * MoltZap agent client — outbound RPC only, no app-callback inbound
 * dispatch. `request` is narrowed to `AnyAgentClientRpcDefinition`; app-only
 * methods are unreachable at compile time (Spec D3 R11/R13).
 */
export class MoltZapAgentClient {
  private readonly stateRef: Ref.Ref<Option.Option<ConnState>>;
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
    this.subscribers = this.runtime.runSync(makeSubscriberRegistry());
  }

  get helloOk(): ConnectResult | null {
    return this._helloOk;
  }

  connect(): Effect.Effect<ConnectResult, ConnectError> {
    // Unlike `MoltZapAppClient.connect`, this arm has no
    // `if (this.closed) Effect.fail(...)` fast-fail guard: a `connect()`
    // after `close()` runs the handshake against the disposed runtime
    // rather than short-circuiting. Behavior preserved as-is here; see
    // `app-client.ts → MoltZapAppClient.connect` for the guarded variant.
    return this.runtime.runtimeEffect.pipe(
      Effect.flatMap(() => this.connectEffect()),
      Effect.provide(this.runtime),
    );
  }

  /**
   * Outbound RPC, typed per method. `call("task/request", payload)` returns
   * `Effect&lt;TaskRequestResult, &lt;that method's errors> | NotConnectedError |
   * RpcTimeoutError>` — the result and the tagged-error union are recovered per
   * tag from `AgentCallableGroup`, so an app-only method or a wrong-shape
   * payload does not typecheck. The agent group's tags are the only callable
   * surface; there is no generic `sendRpc` escape hatch.
   */
  call<Tag extends AgentCallableTag>(
    tag: Tag,
    payload: PayloadForTag<AgentCallableRpcs, Tag>,
    opts?: RpcCallOptions,
  ): Effect.Effect<
    SuccessForTag<AgentCallableRpcs, Tag>,
    ErrorForTag<AgentCallableRpcs, Tag> | NotConnectedError | RpcTimeoutError
  > {
    const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
    return this.callEffect(tag, payload, timeoutMs);
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
      // The native engine fails its in-flight RPCs with `NotConnectedError`
      // when the connection scope closes below; no separate pending-drain.
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
    this.runtime.runFork(Fiber.interrupt(state.value.readerFiber));
    // Closing the scope drains the native engine's in-flight RPCs.
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
      // The native engines write only enveloped frame strings; the socket
      // close path writes a `CloseEvent`. `WireWrite` is string-only, so the
      // engines bind this narrowed writer.
      const wireWrite = (chunk: string) => write(chunk);

      // c2s: the native outbound client (descriptor-driven `call`).
      const native = yield* buildNativeClient({
        group: AgentCallableGroup,
        write: wireWrite,
        scope,
      });
      // s2c: the reverse server serving notifications into the subscriber
      // registry. An agent is never a moderator, so the three callback handlers
      // reject (never invoked).
      const reverse = yield* buildReverseServer({
        registry: this.subscribers,
        callbackHandlers: makeAgentCallbackHandlers(),
        write: wireWrite,
        scope,
      });

      const handshakeSettled = yield* Deferred.make<
        ConnectResult,
        ConnectError
      >();
      const disconnects = yield* Mailbox.make<number>();
      const readerFiber = this.runtime.runFork(
        runMuxReader(
          socket,
          { c2s: native.sink, s2c: reverse.sink },
          disconnects,
        ).pipe(
          Effect.onExit((exit) =>
            this.handleReaderExit(exit, handshakeSettled),
          ),
        ),
      );

      yield* this.publishConnectionState({
        write,
        readerFiber,
        scope,
        client: native.client,
        handshakeSettled,
      });
      return yield* this.awaitConnectAuth(handshakeSettled);
    });
  }

  private webSocketUrl(): string {
    return webSocketUrl(this.options.serverUrl);
  }

  private openSocket(
    url: string,
    scope: Scope.CloseableScope,
  ): Effect.Effect<
    ClientWebSocket,
    NotConnectedError,
    Socket.WebSocketConstructor
  > {
    return openSocket(url, scope, () => {
      this.runtime.runFork(Scope.close(scope, Exit.void));
    });
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
    const authEffect = this.call(Connect.name, {
      credential: this.options.agentKey,
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

  private callEffect<Tag extends AgentCallableTag>(
    tag: Tag,
    payload: PayloadForTag<AgentCallableRpcs, Tag>,
    timeoutMs: number,
  ): Effect.Effect<
    SuccessForTag<AgentCallableRpcs, Tag>,
    ErrorForTag<AgentCallableRpcs, Tag> | NotConnectedError | RpcTimeoutError
  > {
    return Ref.get(this.stateRef).pipe(
      Effect.flatMap((state) => {
        const client = Option.isSome(state) ? state.value.client : undefined;
        if (client === undefined) return Effect.fail(makeNotConnectedError());
        return dispatchCall(client, tag, payload).pipe(
          // The engine surfaces a closed socket as `RpcClientError`; the
          // client's transport-level contract is `NotConnectedError`.
          Effect.catchTag("RpcClientError", () =>
            Effect.fail(makeNotConnectedError()),
          ),
          Effect.timeoutFail({
            duration: `${timeoutMs} millis`,
            onTimeout: () => new RpcTimeoutError({ method: tag, timeoutMs }),
          }),
        );
      }),
    );
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectFiber !== null) return;
    // The reconnect loop body is shared (`runtime/reconnect.ts →
    // makeReconnectLoop`, identical to `MoltZapAppClient`). The per-class
    // guard above + `runtime.runFork` here stay local because they touch this
    // client's `reconnectFiber` / `closed` state.
    const loop = makeReconnectLoop({
      connectEffect: () => this.connectEffect(),
      onReconnect: (helloOk) => this.options.onReconnect?.(helloOk),
      onLoopEnd: () => {
        this.reconnectFiber = null;
      },
    });
    this.reconnectFiber = this.runtime.runFork(loop);
  }
}
