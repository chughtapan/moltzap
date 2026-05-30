/* eslint-disable jsdoc/text-escaping -- JSDoc references to generic types use natural angle-bracket form (TS source style) inside backtick code spans; matches filter-equivalence.test.ts precedent. */
import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  ManagedRuntime,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect";
import {
  PROTOCOL_VERSION,
  Connect,
  DispatchAuthorize,
  MessagesAuthorize,
  TaskCreate,
  encodeErrorResponse,
  makeErasedSlot,
  makeTaskMasterConnection,
  NotConnectedError,
  RpcTimeoutError,
  type AnyNotificationDefinition,
  type DecodedNotification,
  type DecodedServerInbound,
  type ErasedSlot,
  type ErasedSlotTable,
  type JsonRpcId,
  type NotificationParamsOf,
  type ParamsOf,
  type ResponseFrame,
  type ResultOf,
  type RpcCallError,
  type RpcDefinition,
  type SlotDispatchContext,
  type TaskMasterConnection,
  type TaskMasterHandlers,
} from "@moltzap/protocol";
import type { Static, TSchema } from "@sinclair/typebox";
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
import {
  MALFORMED_FRAME_PREVIEW_CHARS,
  MSG_NOT_CONNECTED,
  NORMAL_CLOSE_CODE,
  UTF8_DECODER,
  makeNotConnectedError,
  makeReconnectLoop,
  openSocket,
  shouldLogMalformedFrame,
  webSocketUrl,
  type ClientWebSocket,
} from "./runtime/reconnect.js";

// Re-export `CloseInfo` so consumers can import it from
// `@moltzap/client` alongside `MoltZapTMClient` itself; the type lives
// in `runtime/close-info.ts` for build hygiene but the public surface
// is the package barrel and direct `tm-client.ts` import path.
export type { CloseInfo };

/**
 * Default per-RPC timeout. Exported so tests driving `TestClock` can match
 * exactly — keeps tests from silently drifting if this changes.
 */
export const RPC_TIMEOUT_MS = 30_000;

export interface RpcCallOptions {
  readonly timeoutMs?: number;
}

type ConnectError = RpcCallError | RpcTimeoutError;

/**
 * Capacity of the per-connection task-callback executor queue. Sized at
 * 8192 to preserve the pre-cutover burst envelope (256 partitions × 32
 * per-partition queue depth = 8192). Sized once at queue construction;
 * the queue is bounded so the WS reader exerts back-pressure on a slow
 * handler instead of leaking memory.
 *
 * Per architect plan #533 §"Revisions r1 correction 3": this matches
 * today's burst envelope under the partition-replaced single-drain
 * topology.
 */
const TASK_CALLBACK_QUEUE_CAPACITY = 8192;

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

/**
 * Per-connection runtime state. `None` = not connected → `sendRpc` fails fast
 * with `NotConnectedError`.
 *
 * Cutover (#533): the partitioned dispatcher is replaced by a single
 * bounded global queue + single drain fiber. The queue holds decoded
 * server-initiated requests; the drain fiber runs handlers serially.
 * Capacity = `TASK_CALLBACK_QUEUE_CAPACITY` (8192, preserves the
 * pre-cutover 256×32 burst envelope). Held here alongside its own
 * `dispatcherScope` (NOT bound to the socket scope) so
 * `runSync(client.close())` can `runFork(Scope.close(…))` without
 * yielding through the runtime — the load-bearing regression gate.
 */
interface ConnState {
  readonly write: (
    chunk: string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly readerFiber: Fiber.RuntimeFiber<void, Socket.SocketError>;
  readonly scope: Scope.CloseableScope;

  /**
   * Spec F (#617) typed-dispatcher Connection. Carries the originator
   * (outbound `call` + response `resolve`) and the inbound TM-callback
   * `handle` driven by the immutable handler table the client was
   * constructed with.
   */
  readonly tmConn: TaskMasterConnection<never, TaskCallbackContext>;

  /**
   * Settled when the reader fiber exits, letting `connect()` race against
   * pre-open close and fail fast instead of waiting the RPC timeout.
   */
  readonly handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>;

  /**
   * Per-connection task-callback executor queue. Bounded; the WS reader
   * non-blockingly offers decoded requests, the drain fiber runs
   * handlers one at a time. Replaces the pre-cutover partitioned
   * dispatcher with the simpler single-queue topology.
   */
  readonly taskCallbackQueue: Queue.Queue<DecodedServerRequest>;

  /**
   * Closeable Scope owning the drain fiber. Off-Scope from the socket
   * so `runSync(client.close())` can `runFork(Scope.close(...))`
   * without yielding.
   */
  readonly dispatcherScope: Scope.CloseableScope;
}

type DecodedServerRequest = Extract<
  DecodedServerInbound,
  { readonly _tag: "ServerRequest" }
>;

interface TaskCallbackDispatcher {
  readonly dispatcherScope: Scope.CloseableScope;
  readonly taskCallbackQueue: Queue.Queue<DecodedServerRequest>;
}

/**
 * Per-frame context the WS client threads through the Spec F typed
 * dispatcher when invoking a TM-callback handler. The dispatcher reads
 * the slot's definition off the static handler table — handlers only need
 * the request id (e.g. for tracing / logging). The empty `traceparent`
 * passthrough is intentional: when the wire frame carries an OTel
 * traceparent header, the surrounding transport may layer it on; the
 * typed-dispatcher does not encode tracing into the type.
 */
export interface TaskCallbackContext {
  readonly requestId: JsonRpcId;
}

/**
 * Public handler-table type for `TMClientOptions.handlers`.
 * Re-exposes the protocol's `TaskMasterHandlers` mapped type bound to the
 * client's per-frame context. Spec D3 R14b made every slot REQUIRED;
 * vacuous-deny moderators bind an explicit `ForbiddenError -32001`
 * handler.
 */
export type TMHandlers = TaskMasterHandlers<TaskCallbackContext>;

/**
 * The cast-free slot table the TM connection dispatches against (#705
 * HALF-1). `Env = never` (TM-callback handlers yield no service tags) and
 * `Conn = TaskCallbackContext` (the per-frame ctx carried by
 * `SlotDispatchContext`).
 */
type TMSlotTable = ErasedSlotTable<never, TaskCallbackContext>;

/**
 * Wrap ONE authored TM-callback slot into a cast-free `ErasedSlot` (#705
 * HALF-1), generic over its `params`/`result` schemas (`P`/`R`) so those
 * types stay correlated per method. The TM-callback catalog declares NO
 * capabilities, so the providers tuple is the empty tuple `[]`; the
 * `makeErasedSlot` `handler` receives `SlotDispatchContext<TaskCallbackContext>`
 * and unwraps `.connection` to hand the authored `handle` its bare
 * `TaskCallbackContext`.
 */
function wrapTmSlot<P extends TSchema, R extends TSchema>(slot: {
  readonly definition: Omit<RpcDefinition<string, P, R>, "capabilities"> & {
    readonly capabilities: readonly [];
  };
  readonly handle: (
    params: Static<P>,
    ctx: TaskCallbackContext,
  ) => Effect.Effect<Static<R>, unknown, never>;
}): ErasedSlot<never, TaskCallbackContext> {
  return makeErasedSlot(
    slot.definition,
    (params, ctx: SlotDispatchContext<TaskCallbackContext>) =>
      slot.handle(params, ctx.connection),
    [],
  );
}

/**
 * Convert the public {@link TMHandlers} authoring table into the cast-free
 * {@link TMSlotTable} `makeTaskMasterConnection` consumes (#705 HALF-1). The
 * TM-callback catalog is closed (`DispatchAuthorize`, `MessagesAuthorize`,
 * `TaskCreate`); each slot is wrapped at its own concrete definition type via
 * {@link wrapTmSlot} so the per-method `params`/`result` lockstep holds (a
 * `Object.values` loop would collapse the three arms into a union and break
 * `makeErasedSlot`'s typed `definition`/`handler` correlation).
 */
function tmHandlersToSlots(handlers: TMHandlers): TMSlotTable {
  return {
    [DispatchAuthorize.name]: wrapTmSlot(handlers["dispatch/authorize"]),
    [MessagesAuthorize.name]: wrapTmSlot(handlers["messages/authorize"]),
    [TaskCreate.name]: wrapTmSlot(handlers["task/create"]),
  };
}

export interface TMClientOptions {
  serverUrl: string;
  agentKey: string;

  /**
   * D #705 CP8 — app-principal credential. When set, the `network/connect`
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
   * Spec D3 R14b — REQUIRED. TM-callback handler table immutable at
   * construction (Spec F I1). Keys are catalog method names
   * (`"dispatch/authorize"`, `"messages/authorize"`); each value carries
   * the matching `defineRpc` descriptor and its handler effect.
   * Vacuous-deny moderators write the explicit ForbiddenError handler.
   */
  handlers: TMHandlers;
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
 *   CONNECTING : openSocket 10s timeout<br>startTaskCallbackDispatcher<br>readerFiber forked<br>sendRpc(Connect) in flight
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
export class MoltZapTMClient {
  private readonly stateRef: Ref.Ref<Option.Option<ConnState>>;
  private readonly malformedRef: Ref.Ref<number>;
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Socket.WebSocketConstructor,
    never
  >;

  /**
   * Per-subscription notification registry. Spec #596 / Spec B: callback-based
   * storage feeds `Stream.async` consumers via `notification/stream.ts`.
   */
  private readonly subscribers: SubscriberRegistry;

  /**
   * Spec F (#617) immutable TM-callback handler table. Captured from
   * `TMClientOptions.handlers` at construction and threaded through
   * every `makeTaskMasterConnection` call (including reconnects).
   */
  private readonly handlers: TMHandlers;

  private closed = false;
  private reconnectFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private _helloOk: ConnectResult | null = null;

  constructor(private readonly options: TMClientOptions) {
    this.runtime = ManagedRuntime.make(NodeSocket.layerWebSocketConstructor);
    this.stateRef = this.runtime.runSync(
      Ref.make<Option.Option<ConnState>>(Option.none()),
    );
    this.malformedRef = this.runtime.runSync(Ref.make(0));
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
   *   participant client as MoltZapTMClient
   *   participant server
   *
   *   caller->>client: new MoltZapTMClient(options)
   *   Note over client: stateRef = None, subscribers, ManagedRuntime
   *   caller->>client: subscribe(filter, handler)
   *   Note over client: SubscriberRegistry.register — survives reconnect
   *   caller->>client: connect()
   *   Note over client: connectEffect — Scope.make, Socket.makeWebSocket open<br>startTaskCallbackDispatcher — bounded Queue 8192 + drain<br>readerFiber = runFork(readerEffect)
   *   client->>server: TCP open + WS upgrade
   *   client->>server: network/connect {agentKey, minProtocol, maxProtocol}
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
   * `appCallbackHandlers` (immutable, value-captured at construction),
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
   * Send an RPC. Fails with a typed error:
   *   - `NotConnectedError` if the socket isn't OPEN or closes mid-RPC
   *   - `RpcTimeoutError` after `RPC_TIMEOUT_MS` — no automatic retry
   *   - a registered tagged error for known protocol error codes
   *   - `RpcServerError` for unknown protocol error codes
   *
   * Descriptor-backed RPC call. Callers pass the protocol descriptor, and the
   * client extracts the wire method only inside the encoder path.
   */
  sendRpc<D extends RpcDefinition<string, any, any>>(
    definition: D,
    params: ParamsOf<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ResultOf<D>, ConnectError> {
    const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
    return this.sendRpcEffect(definition, params, timeoutMs);
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
      yield* this.failAllPending(MSG_NOT_CONNECTED);
      // Drop every live subscription so handlers stop firing once
      // the client is permanently torn down. The registry invokes each
      // sub's `onClose(new NotConnectedError(...))` callback, which fires
      // `emit.fail` on the corresponding consumer Stream. Subsumes the
      // deleted `failAllNotificationWaiters` semantic (spec #596 §3.2 +
      // §"Stream lifecycle contract" row 5).
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
        // The dispatcher Scope is NOT bound to the socket Scope (see
        // ConnState doc): tear it down via runFork so this Effect
        // remains sync-runnable for callers using
        // `runSync(client.close())`. Closing the dispatcher Scope
        // interrupts the drain fiber via Scope finalizers; the
        // bounded queue is then garbage-collected.
        this.runtime.runFork(
          Scope.close(state.value.dispatcherScope, Exit.void),
        );
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
    this.runtime.runFork(this.failConnectionPending(state.value));
    // Interrupt the reader fiber. runRaw exits, the socket scope closes,
    // ws.close(1000) fires as part of that teardown.
    this.runtime.runFork(Fiber.interrupt(state.value.readerFiber));
    // Close the per-connection scope as a belt-and-braces guarantee.
    this.runtime.runFork(Scope.close(state.value.scope, Exit.void));
    // Tear down the task-callback dispatcher Scope (off-scope, see
    // ConnState doc). runFork so disconnectSync stays synchronous for
    // callers using `runSync(client.disconnect())`. Closing the
    // dispatcher Scope interrupts the drain fiber via Scope
    // finalizers.
    this.runtime.runFork(Scope.close(state.value.dispatcherScope, Exit.void));
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
      const tmConn = yield* Scope.extend(
        makeTaskMasterConnection<never, TaskCallbackContext>({
          id: "tm-client",
          slots: tmHandlersToSlots(this.handlers),
          write: (raw) => write(raw),
          idPrefix: "rpc",
        }),
        scope,
      );
      const handshakeSettled = yield* Deferred.make<
        ConnectResult,
        ConnectError
      >();
      const dispatcher = yield* this.startTaskCallbackDispatcher(write, tmConn);
      const readerFiber = this.runtime.runFork(
        this.readerEffect(socket, handshakeSettled, dispatcher.dispatcherScope),
      );

      yield* this.publishConnectionState({
        write,
        readerFiber,
        scope,
        tmConn,
        handshakeSettled,
        taskCallbackQueue: dispatcher.taskCallbackQueue,
        dispatcherScope: dispatcher.dispatcherScope,
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

  private startTaskCallbackDispatcher(
    write: ConnState["write"],
    tmConn: TaskMasterConnection<never, TaskCallbackContext>,
  ): Effect.Effect<TaskCallbackDispatcher> {
    return Effect.gen(this, function* () {
      const dispatcherScope = yield* Scope.make();
      const taskCallbackQueue = yield* Queue.bounded<DecodedServerRequest>(
        TASK_CALLBACK_QUEUE_CAPACITY,
      );
      const drainEffect = Effect.forever(
        Queue.take(taskCallbackQueue).pipe(
          Effect.flatMap((req) =>
            this.dispatchInboundServerRequest(req, write, tmConn),
          ),
        ),
      );
      yield* Effect.forkIn(drainEffect, dispatcherScope);
      return { dispatcherScope, taskCallbackQueue };
    });
  }

  private readerEffect(
    socket: ClientWebSocket,
    handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>,
    dispatcherScope: Scope.CloseableScope,
  ): Effect.Effect<void, Socket.SocketError> {
    return socket
      .runRaw((data) =>
        this.handleIncoming(
          typeof data === "string" ? data : UTF8_DECODER.decode(data),
        ),
      )
      .pipe(
        Effect.onExit((exit) =>
          this.handleReaderExit(exit, handshakeSettled, dispatcherScope),
        ),
      );
  }

  private handleReaderExit(
    exit: Exit.Exit<void, Socket.SocketError>,
    handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>,
    dispatcherScope: Scope.CloseableScope,
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
      this.runtime.runFork(Scope.close(dispatcherScope, Exit.void));
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
    // D #705 CP8 — dispatch the disjoint Connect params union on the
    // configured credential: an `appKey` authenticates as an `AppConnection`
    // (no `agentId` in the HelloOk); otherwise fall back to the `agentKey`
    // agent arm. The two arms are structurally disjoint at the wire so the
    // server's `network/connect` handler routes on the present field.
    const handshakeParams: ParamsOf<typeof Connect> =
      this.options.appKey !== undefined
        ? {
            appKey: this.options.appKey,
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
          }
        : {
            agentKey: this.options.agentKey,
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
          };
    const authEffect = this.sendRpc(Connect, handshakeParams);
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
      // `sendRpc` is the public surface; callers pass concrete descriptors
      // narrowed at the call site. The typed-dispatcher's `call` is
      // constrained to `AnyServerRpcDefinition` (the union of catalog members);
      // the bound carry-through is preserved by widening to the union here.
      const call = state.value.tmConn.call as <
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

  /**
   * Write a "queue-full" error response back to the server when the
   * task-callback executor queue is saturated. Bounded-queue offer
   * returns `false` rather than blocking; we surface that to the
   * server's `Deferred.await` so it settles deterministically.
   */
  private writeQueueFullRejection(
    requestId: JsonRpcId,
    write: ConnState["write"],
  ): Effect.Effect<void, never> {
    const reply: ResponseFrame = encodeErrorResponse(requestId, {
      code: -32000,
      message: `Server busy: task-callback executor queue full (capacity=${TASK_CALLBACK_QUEUE_CAPACITY})`,
    });
    return write(JSON.stringify(reply)).pipe(
      Effect.catchAll((werr) =>
        Effect.logWarning(
          "task-callback queue-full rejection write failed",
          werr,
        ),
      ),
    );
  }

  /**
   * Dispatch one inbound appCallback request through the typed Spec F
   * dispatcher and write its wire response back to the server. Spec D3
   * R14b made every TM-callback slot REQUIRED at construction, so the
   * dispatcher always finds a bound handler. Handler defects collapse
   * to a generic InternalError reply so the server's `Deferred.await`
   * always settles deterministically.
   */
  private dispatchInboundServerRequest(
    request: DecodedServerRequest,
    write: ConnState["write"],
    tmConn: TaskMasterConnection<never, TaskCallbackContext>,
  ): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      // #705 HALF-1 — the dispatcher ctx is `SlotDispatchContext<Conn>`
      // (`{ connection: Conn }`); `Conn = TaskCallbackContext`, so the
      // per-frame `requestId` rides on `connection`. The slot's
      // `makeErasedSlot` wrapper unwraps `.connection` to hand the
      // authored `handle` its bare `TaskCallbackContext`.
      const reply = yield* tmConn.handle(request.frame, {
        connection: { requestId: request.id },
      });
      yield* this.writeInboundServerReply(write, reply);
    });
  }

  private writeInboundServerReply(
    write: ConnState["write"],
    reply: ResponseFrame,
  ): Effect.Effect<void, never> {
    return write(JSON.stringify(reply)).pipe(
      Effect.catchAll((err) =>
        Effect.logWarning("appCallback response write failed", err),
      ),
    );
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
      yield* state.value.tmConn.resolve(decoded.frame).pipe(Effect.asVoid);
    });
  }

  private handleDecodedServerRequest(
    decoded: DecodedServerRequest,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) return;
      const offered = yield* Queue.offer(
        state.value.taskCallbackQueue,
        decoded,
      );
      if (!offered) {
        yield* this.writeQueueFullRejection(decoded.id, state.value.write);
      }
    });
  }

  /**
   * Inbound notification routing. Spec #596 / Spec B: dispatch fans out
   * through the registry's stored `onFrame` callbacks into each
   * subscription's `Stream.async` source. The pre-arrival buffer and
   * waiter-pop branches were deleted in Spec B (no top-level waiter, no
   * `notificationsBufferRef`).
   */
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

  /**
   * Route an inbound frame. Malformed frames are logged + dropped; notification
   * frames fan out through the per-subscription registry (Spec B).
   */
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
    return state.tmConn.failAllPending(
      new NotConnectedError({ message: MSG_NOT_CONNECTED }),
    );
  }

  private failAllPending(message: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) return;
      yield* state.value.tmConn.failAllPending(
        new NotConnectedError({ message }),
      );
    });
  }

  /**
   * Schedule a reconnect attempt. Jittered exponential backoff (1s base,
   * 30s cap) routed through `Effect.sleep` so `TestClock` can drive it.
   */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectFiber !== null) return;
    // The reconnect loop body is shared (`runtime/reconnect.ts →
    // makeReconnectLoop`, #705 CP-F A6-base — byte-identical to
    // `MoltZapAgentClient`). The per-class guard above + `runtime.runFork`
    // here stay local because they touch this client's `reconnectFiber` /
    // `closed` state.
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
