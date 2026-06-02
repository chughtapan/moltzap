/* eslint-disable jsdoc/text-escaping -- JSDoc references to generic types use natural angle-bracket form (TS source style) inside backtick code spans; matches filter-equivalence.test.ts precedent. */
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
  AppCallableGroup,
  Connect,
  NotConnectedError,
  RpcTimeoutError,
  runMuxReader,
  type AnyNotificationDefinition,
  type DecodedNotification,
  type JsonRpcId,
  type NotificationParamsOf,
  type ParamsOf,
  type ResultOf,
  type AppCallbackHandlers,
} from "@moltzap/protocol";
import { buildNativeClient } from "./runtime/native-mux-client.js";
import {
  makeTypedTransportCall,
  type TypedDispatchMap,
  type PayloadForTag,
  type SuccessForTag,
  type ErrorForTag,
} from "./runtime/typed-dispatch.js";
import { buildReverseServer } from "./runtime/reverse-rpc-server.js";
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

// Re-export `CloseInfo` so consumers can import it from
// `@moltzap/client` alongside `MoltZapAppClient` itself; the type lives
// in `runtime/close-info.ts` for build hygiene but the public surface
// is the package barrel and direct `app-client.ts` import path.
export type { CloseInfo };

/**
 * Default per-RPC timeout. Exported so tests driving `TestClock` can match
 * exactly — keeps tests from silently drifting if this changes.
 */
export const RPC_TIMEOUT_MS = 30_000;

export interface RpcCallOptions {
  readonly timeoutMs?: number;
}

type ConnectResult = ResultOf<typeof Connect>;

/** The app group's member `Rpc`s — the tag-keyed dispatch surface. */
type AppCallableRpcs = RpcGroup.Rpcs<typeof AppCallableGroup>;

/** The branded wire tags the app client may originate. */
type AppCallableTag = AppCallableRpcs["_tag"];

/** The handshake's error channel: `network/connect`'s errors plus transport. */
type ConnectError = Effect.Effect.Error<ReturnType<MoltZapAppClient["call"]>>;

/**
 * Per-connection runtime state. `None` = not connected → `call` fails fast with
 * `NotConnectedError`. The c2s native non-flat client is the outbound dispatch
 * surface; the s2c reverse `RpcServer` (built in `connectEffect`) serves the
 * moderator callbacks + notifications and is owned by the connection scope.
 */
interface ConnState {
  readonly write: (
    chunk: string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly readerFiber: Fiber.RuntimeFiber<void, Socket.SocketError>;
  readonly scope: Scope.CloseableScope;
  readonly client: TypedDispatchMap<AppCallableRpcs, RpcClientError>;

  /**
   * Settled when the reader fiber exits, letting `connect()` race against
   * pre-open close and fail fast instead of waiting the RPC timeout.
   */
  readonly handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>;
}

/**
 * Per-callback context handed to an authored app-callback handler — the request
 * id (for tracing / logging). The reverse `RpcServer` engine assigns request
 * ids internally; the authored handlers that read `requestId` receive a
 * placeholder, the payload is the load-bearing input.
 */
export interface AppCallbackContext {
  readonly requestId: JsonRpcId;
}

/**
 * Public handler-table type for `AppClientOptions.handlers`. Re-exported
 * straight from `@moltzap/protocol`. Every slot is REQUIRED; vacuous-deny
 * moderators bind an explicit `ForbiddenError` handler.
 */
export type { AppCallbackHandlers };

/** Placeholder request id for the authored handler's `AppCallbackContext`. */
const CALLBACK_CONTEXT: AppCallbackContext = {
  requestId: "reverse-rpc" as JsonRpcId,
};

/**
 * Convert the authored {@link AppCallbackHandlers} table into the reverse
 * `RpcServer` handler shape (`tag → (params) => Effect<result>`). Each authored
 * `handle(params, ctx)` becomes a `(params) => handle(params, ctx)` the engine
 * serves over the s2c channel; the engine encodes the result back as the
 * callback's wire response.
 */
function makeAppCallbackHandlers(
  handlers: AppCallbackHandlers<AppCallbackContext>,
): Record<string, (params: unknown) => Effect.Effect<unknown, unknown>> {
  const adapt =
    (slot: {
      readonly handle: (
        params: never,
        ctx: AppCallbackContext,
      ) => Effect.Effect<unknown, unknown, never>;
    }) =>
    (params: unknown) =>
      slot.handle(params as never, CALLBACK_CONTEXT);
  return {
    "dispatch/authorize": adapt(handlers["dispatch/authorize"]),
    "messages/authorize": adapt(handlers["messages/authorize"]),
    "task/create": adapt(handlers["task/create"]),
  };
}

export interface AppClientOptions {
  serverUrl: string;
  agentKey: string;

  /**
   * App-principal credential. When set, the `network/connect`
   * handshake uses the `appKey` arm (`{ appKey, minProtocol, maxProtocol }`)
   * instead of the `agentKey` arm, so the server mints an `AppConnection`
   * and the HelloOk carries no `agentId`. Used by wire app clients (a
   * moderator app authenticating as an app principal); wire agent clients
   * leave it unset and authenticate via `agentKey`. The two are mutually
   * exclusive at the wire — the Connect params union is disjoint — so a
   * configured `appKey` wins the handshake-credential selection in
   * `awaitConnectAuth`. (The boot-installed default app is NOT a client: it
   * registers a hookless manifest server-side and is served by AppHost's
   * manifest-default fast-path.)
   */
  appKey?: string;

  /**
   * Called once per disconnect (not reconnect). Spec #222 §5.4 + OQ-5 (A):
   * `close` is the typed close metadata — real WebSocket `{code, reason}`
   * when the transport surfaces them, OQ-5 defaults otherwise.
   *
   * Migration note (spec #596): the previous `subscribe(filter, handler)` /
   * `waitForNotification` / `notificationsBufferRef` surface was deleted in
   * Spec B. Callers consume notifications via `subscribe(def, refinement?)`
   * returning a `Stream`, or `subscribeAll(refinement?)` for the broad-union
   * escape hatch.
   */
  onDisconnect?: (close: CloseInfo) => void;
  onReconnect?: (helloOk: ConnectResult) => void;

  /**
   * Spec D3 R14b — REQUIRED. app-callback handler table immutable at
   * construction (Spec F I1). Keys are catalog method names
   * (`"dispatch/authorize"`, `"messages/authorize"`); each value carries
   * the matching `defineRpc` descriptor and its handler effect.
   * Vacuous-deny moderators write the explicit ForbiddenError handler.
   */
  handlers: AppCallbackHandlers<AppCallbackContext>;
}

/**
 * WebSocket lifecycle: open → network/connect → active. On disconnect,
 * exponential backoff (1s base, 30s cap, jittered) retries the handshake via
 * `Effect.sleep` + `Schedule` so TestClock can drive it. Public API is
 * Effect-based — consumers run the returned Effects themselves (typically at
 * a framework or CLI edge).
 *
 * Connection state machine, driven by `stateRef` (`None` | `Some(ConnState)`)
 * and the `closed` flag:
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> INIT
 *   INIT : stateRef None, closed false
 *   INIT --> CONNECTING : connect()
 *   CONNECTING : openSocket 10s timeout<br>startAppCallbackDispatcher<br>readerFiber forked<br>sendRpc(Connect) in flight
 *   CONNECTING --> CONNECTED : HelloOk received<br>stateRef = Some(ConnState)
 *   CONNECTED : _helloOk set, reader fiber active
 *   CONNECTED --> DISCONNECTED : reader fiber exit<br>failAllPending, stateRef = None<br>onDisconnect(closeInfo)
 *   DISCONNECTED : reconnectable, closed false
 *   DISCONNECTED --> CONNECTING : scheduleReconnect<br>exponential backoff 1s..30s jittered<br>connectEffect → onReconnect(helloOk)
 *   INIT --> CLOSED : close()
 *   CONNECTING --> CLOSED : close()
 *   CONNECTED --> CLOSED : close()
 *   DISCONNECTED --> CLOSED : close()
 *   CLOSED : terminal — closed true<br>stateRef None, reconnectFiber null<br>no further reconnects
 *   CLOSED --> [*]
 * ```
 *
 * `close()` is total from any state: interrupts the reconnect fiber,
 * `failAllPending` + `failAllNotificationWaiters`, `subscribers.closeAll`,
 * writes `CloseEvent(1000)` if the handshake completed, closes the
 * connection and dispatcher scopes, disposes the `ManagedRuntime`.
 *
 * Transport: `@effect/platform/Socket.makeWebSocket` backed by
 * `@effect/platform-node/NodeSocket.layerWebSocketConstructor`. The Node
 * `WebSocketConstructor` layer is provided internally via `ManagedRuntime`
 * so callers' `connect()` / `sendRpc()` Effects have no extra requirement.
 *
 * Notification consumption: use `subscribe(def, refinement?)` for typed
 * payload Streams; `subscribeAll(refinement?)` for the broad-union
 * escape hatch. Both return `Stream.Stream` of `DecodedNotification` with
 * a `NotConnectedError` error channel. Consume via `Stream.runForEach`
 * (long-lived) or `Stream.runHead` + `Effect.timeoutFail` (one-shot).
 */
export class MoltZapAppClient {
  private readonly stateRef: Ref.Ref<Option.Option<ConnState>>;
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Socket.WebSocketConstructor,
    never
  >;

  /**
   * Per-subscription notification registry. Callback-based storage feeds
   * `Stream.async` consumers via `notification/stream.ts`; the s2c reverse
   * server's notification handlers dispatch into it.
   */
  private readonly subscribers: SubscriberRegistry;

  /**
   * Immutable app-callback handler table. Captured from
   * `AppClientOptions.handlers` at construction and threaded into the s2c
   * reverse `RpcServer` on every connect (including reconnects).
   */
  private readonly handlers: AppCallbackHandlers<AppCallbackContext>;

  private closed = false;
  private reconnectFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private _helloOk: ConnectResult | null = null;

  constructor(private readonly options: AppClientOptions) {
    this.runtime = ManagedRuntime.make(NodeSocket.layerWebSocketConstructor);
    this.stateRef = this.runtime.runSync(
      Ref.make<Option.Option<ConnState>>(Option.none()),
    );
    this.subscribers = this.runtime.runSync(makeSubscriberRegistry());
    this.handlers = options.handlers;
  }

  get helloOk(): ConnectResult | null {
    return this._helloOk;
  }

  /**
   * Open the socket, perform `network/connect`, resolve with HelloOk.
   * Fails immediately on pre-open close or error.
   *
   * ```mermaid
   * sequenceDiagram
   *   participant caller
   *   participant client as MoltZapAppClient
   *   participant server
   *
   *   caller->>client: new MoltZapAppClient(options)
   *   Note over client: stateRef = None, subscribers, ManagedRuntime
   *   caller->>client: subscribe(def, refinement?)
   *   Note over client: SubscriberRegistry.register — survives reconnect
   *   caller->>client: connect()
   *   Note over client: connectEffect — Scope.make, Socket.makeWebSocket open<br>startAppCallbackDispatcher — bounded Queue 8192 + drain<br>readerFiber = runFork(readerEffect)
   *   client->>server: TCP open + WS upgrade
   *   client->>server: network/connect {appKey | agentKey, minProtocol, maxProtocol} — appKey wins when set
   *   server-->>client: HelloOk
   *   Note over client: stateRef = Some(connState), _helloOk = value
   *   client-->>caller: HelloOk
   *   Note over client,server: steady state — reader fiber loops on socket.runRaw
   * ```
   *
   * Reconnect arm fires from `handleReaderExit` when the reader fiber
   * exits with `closed === false`. `failAllPending` settles every
   * in-flight Deferred with `NotConnectedError`, `notifyDisconnect`
   * surfaces the close info, then `scheduleReconnect` forks an
   * exponential-backoff retry (`1s × 2^n, cap 30s, +jitter`).
   *
   * State that SURVIVES reconnect: `SubscriberRegistry` entries,
   * `handlers` (immutable, value-captured at construction),
   * `ManagedRuntime`.
   *
   * State that does NOT survive reconnect: in-flight RPC Deferreds
   * (failed via `failAllPending`), the prior `ConnState` (scope,
   * reader fiber, callback queue, dispatcher scope) — rebuilt fresh.
   */
  connect(): Effect.Effect<ConnectResult, ConnectError> {
    return Effect.suspend(() => {
      if (this.closed) {
        return Effect.fail(makeNotConnectedError());
      }
      return this.connectEffect().pipe(
        // `makeWebSocket` requires `Socket.WebSocketConstructor`; our
        // internal Node layer provides it so callers' Effects stay
        // requirement-free (same public shape the legacy client had).
        Effect.provide(NodeSocket.layerWebSocketConstructor),
      );
    });
  }

  /**
   * Outbound RPC, typed per method. `call("task/close", payload)` returns
   * `Effect<TaskCloseResult, <that method's errors> | NotConnectedError |
   * RpcTimeoutError>` — the result and tagged-error union are recovered per tag
   * from `AppCallableGroup`. The app group's tags are the only callable
   * surface; an agent-only method does not typecheck.
   */
  call<Tag extends AppCallableTag>(
    tag: Tag,
    payload: PayloadForTag<AppCallableRpcs, Tag>,
    opts?: RpcCallOptions,
  ): Effect.Effect<
    SuccessForTag<AppCallableRpcs, Tag>,
    ErrorForTag<AppCallableRpcs, Tag> | NotConnectedError | RpcTimeoutError
  > {
    const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
    return this.callEffect(tag, payload, timeoutMs);
  }

  /**
   * Typed-payload subscribe (spec #596 Goal #1). Returns a Stream of
   * `DecodedNotification<D>` whose error channel is `NotConnectedError`
   * and whose requirement set is `never`.
   *
   * `refinement` is a typed predicate over the definition's params shape.
   * The user-defined-type-guard overload (signature below) narrows the
   * Stream's payload to `DecodedNotification<D, R>`.
   *
   * Lifecycle (spec §"Stream lifecycle contract"):
   *   - Subscription construction is pure (no I/O, no scope). Legal
   *     pre-`connect()`.
   *   - First-pull suspends until the first matching frame arrives or
   *     terminal close fires `NotConnectedError`.
   *   - Reconnect persists subscriptions (`SubscriberRegistry` survives
   *     transient disconnects).
   *   - Terminal close (`client.close()`) terminates every in-flight Stream
   *     with `NotConnectedError`.
   */
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

  /**
   * Broad-union escape hatch (spec #596 Goal #2). Returns a Stream of every
   * inbound notification regardless of definition. Payload narrowing is
   * intentionally lost — callers wanting typed payloads use `subscribe`.
   *
   * The only intended in-tree consumer is `MoltZapService.connect`'s
   * service-wide notification fanout.
   */
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

  /**
   * Close the socket permanently (no reconnection). Writes a clean WebSocket
   * close frame (code 1000) before tearing down the scope so the server
   * observes a graceful handshake rather than an abrupt disconnect, preventing
   * lingering CLOSE_WAIT sockets on the server side.
   */
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
      // Drop every live subscription so handlers stop firing once the client is
      // permanently torn down. The registry invokes each sub's
      // `onClose(new NotConnectedError(...))` callback, which fires `emit.fail`
      // on the corresponding consumer Stream. The native engine fails its
      // in-flight RPCs when the connection scope closes below.
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

  /** Close the socket without marking as permanently closed, triggering reconnection. */
  disconnect(): Effect.Effect<void, never> {
    return Effect.sync(() => this.disconnectSync());
  }

  private disconnectSync(): void {
    const state = this.runtime.runSync(Ref.get(this.stateRef));
    if (Option.isNone(state)) return;
    // Detach from state first so sendRpc fails fast while we tear down.
    this.runtime.runSync(Ref.set(this.stateRef, Option.none()));
    // Interrupt the reader fiber. runRaw exits, the socket scope closes,
    // ws.close(1000) fires as part of that teardown.
    this.runtime.runFork(Fiber.interrupt(state.value.readerFiber));
    // Close the per-connection scope; the native engine drains its in-flight
    // RPCs as the scope tears down.
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
      const wireWrite = (chunk: string) => write(chunk);

      // c2s: the native outbound client (app-callable surface).
      const native = yield* buildNativeClient({
        group: AppCallableGroup,
        write: wireWrite,
        scope,
      });
      // s2c: the reverse server serving moderator callbacks (from the authored
      // handler table) + notifications (into the subscriber registry).
      const reverse = yield* buildReverseServer({
        registry: this.subscribers,
        callbackHandlers: makeAppCallbackHandlers(this.handlers),
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
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });
  }

  private publishConnectionState(state: ConnState): Effect.Effect<void> {
    return Ref.set(this.stateRef, Option.some(state));
  }

  private awaitConnectAuth(
    handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>,
  ): Effect.Effect<ConnectResult, ConnectError> {
    // The single `credential` carries the principal prefix the server
    // resolves: a configured `appKey` (`moltzap_app_`) mints an
    // `AppConnection`, otherwise the `agentKey` (`moltzap_agent_`) runs the
    // agent arm.
    const handshakeParams: ParamsOf<typeof Connect> = {
      credential: this.options.appKey ?? this.options.agentKey,
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
    };
    const authEffect = this.call(Connect.name, handshakeParams);
    return Effect.raceFirst(authEffect, Deferred.await(handshakeSettled)).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          this._helloOk = value;
        }),
      ),
    );
  }

  private callEffect<Tag extends AppCallableTag>(
    tag: Tag,
    payload: PayloadForTag<AppCallableRpcs, Tag>,
    timeoutMs: number,
  ): Effect.Effect<
    SuccessForTag<AppCallableRpcs, Tag>,
    ErrorForTag<AppCallableRpcs, Tag> | NotConnectedError | RpcTimeoutError
  > {
    return Ref.get(this.stateRef).pipe(
      Effect.flatMap((state) => {
        const client = Option.isSome(state) ? state.value.client : undefined;
        if (client === undefined) return Effect.fail(makeNotConnectedError());
        // The same `makeTypedTransportCall` bridge the reverse client uses: a
        // closed socket (`RpcClientError`) folds into `NotConnectedError`, the
        // per-tag success + the method's typed errors reduce cast-free.
        const call = makeTypedTransportCall(client, makeNotConnectedError);
        return call(tag, payload).pipe(
          Effect.timeoutFail({
            duration: `${timeoutMs} millis`,
            onTimeout: () => new RpcTimeoutError({ method: tag, timeoutMs }),
          }),
        );
      }),
    );
  }

  /**
   * Schedule a reconnect attempt. Jittered exponential backoff (1s base,
   * 30s cap) routed through `Effect.sleep` so `TestClock` can drive it.
   */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectFiber !== null) return;
    // The reconnect loop body is shared (`runtime/reconnect.ts →
    // makeReconnectLoop`, identical to `MoltZapAgentClient`). The per-class
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
