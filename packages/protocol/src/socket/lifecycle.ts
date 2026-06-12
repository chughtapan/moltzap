import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { RpcClient, RpcServer, type Rpc, type RpcGroup } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import {
  Cause,
  Data,
  Deferred,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  Layer,
  Mailbox,
  ManagedRuntime,
  Option,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect";
import {
  AgentConnect,
  AppConnect,
  PresenceChangedNotificationDefinition,
} from "#network";
import {
  AgentCallableGroup,
  AppCallableGroup,
  ReverseRpcGroup,
  appCallbackMethods,
  type AnyNotificationDefinition,
} from "#socket/catalog";
import {
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
} from "#message/dispatch";
import {
  ContactAcceptedNotificationDefinition,
  ContactRequestNotificationDefinition,
} from "#identity/contacts";
import { MessageReceivedNotificationDefinition } from "#message";
import {
  TaskConversationArchivedNotificationDefinition,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
} from "#conversation";
import {
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
} from "#task";
import {
  DEFAULT_GRACEFUL_CLOSE,
  extractCloseInfo,
  type CloseInfo,
} from "./close-info.js";
import type {
  NotificationDelivery,
  NotificationParamsOf,
  ResultOf,
} from "#transport";
import {
  makeNotificationSubscriberRegistry,
  notificationSubscribe,
  notificationSubscribeAll,
  type NotificationSubscriberRegistry,
} from "#transport";
import { NotConnectedError, RpcTimeoutError } from "#transport";
import { makeServerProtocolLayer } from "./internal/protocol-layer.js";
import {
  makeClientChannelProtocol,
  runMuxReader,
  type ChannelSink,
  type WireWrite,
} from "#transport";
import {
  makeTypedTransportCall,
  type ErrorForTag,
  type PayloadForTag,
  type SuccessForTag,
  type TypedDispatchMap,
} from "#transport";

export const RPC_TIMEOUT_MS = 30_000;

const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_FACTOR = 2;
const WEB_SOCKET_OPEN_TIMEOUT_SECONDS = 10;
const NORMAL_CLOSE_CODE = 1000;
const GRACEFUL_CLOSE_WRITE_TIMEOUT = Duration.seconds(1);
const MSG_NOT_CONNECTED = "WebSocket not connected";

export interface RpcCallOptions {
  readonly timeoutMs?: number;
}

export type ClientRpcDefinition<Rpcs extends Rpc.Any = Rpc.Any> = {
  readonly clientRpc: Rpcs;
};
export type ClientDefinitionPayload<D extends ClientRpcDefinition> =
  Rpc.PayloadConstructor<D["clientRpc"]>;
export type ClientDefinitionSuccess<D extends ClientRpcDefinition> =
  Rpc.Success<D["clientRpc"]>;
export type ClientDefinitionError<D extends ClientRpcDefinition> =
  | Rpc.Error<D["clientRpc"]>
  | NotConnectedError
  | RpcTimeoutError;

export type ConnectResult = ResultOf<typeof AgentConnect>;
type ProtocolRpc = Rpc.Any & { readonly _tag: string };
type ConnectTag<Rpcs extends ProtocolRpc> = Extract<
  Rpcs["_tag"],
  typeof AgentConnect.name | typeof AppConnect.name
>;
export type ClientConnectError<Rpcs extends ProtocolRpc> =
  | ErrorForTag<Rpcs, ConnectTag<Rpcs>>
  | NotConnectedError
  | RpcTimeoutError;

type ClientWebSocket = Effect.Effect.Success<
  ReturnType<typeof Socket.makeWebSocket>
>;

const makeNotConnectedError = (): NotConnectedError =>
  new NotConnectedError({ message: MSG_NOT_CONNECTED });

const webSocketUrl = (serverUrl: string): string =>
  serverUrl.replace(/^http/, "ws") + "/ws";

const openSocket = (
  url: string,
  scope: Scope.CloseableScope,
): Effect.Effect<
  ClientWebSocket,
  NotConnectedError,
  Socket.WebSocketConstructor
> => {
  const openTimeout = Duration.seconds(WEB_SOCKET_OPEN_TIMEOUT_SECONDS);
  return Scope.extend(Socket.makeWebSocket(url, { openTimeout }), scope).pipe(
    Effect.timeoutFail({
      duration: openTimeout,
      onTimeout: makeNotConnectedError,
    }),
    Effect.catchAllCause((cause) =>
      Effect.zipRight(
        Effect.logWarning("WebSocket open failed", cause),
        Scope.close(scope, Exit.void).pipe(
          Effect.ignore,
          Effect.zipRight(Effect.fail(makeNotConnectedError())),
        ),
      ),
    ),
  );
};

const drainConnectionEffect = (input: {
  readonly write: (
    chunk: Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly scope: Scope.CloseableScope;
  readonly hasCompletedHandshake: boolean;
}): Effect.Effect<void> => {
  const closeScope = Scope.close(input.scope, Exit.void);
  if (!input.hasCompletedHandshake) return closeScope;
  return input
    .write(new Socket.CloseEvent(NORMAL_CLOSE_CODE, "normal"))
    .pipe(
      Effect.timeout(GRACEFUL_CLOSE_WRITE_TIMEOUT),
      Effect.ignore,
      Effect.zipRight(closeScope),
    );
};

const callWithTimeout = <A, E>(
  scope: Scope.Scope,
  call: Effect.Effect<A, E>,
  options: { readonly method: string; readonly timeoutMs: number },
): Effect.Effect<A, E | NotConnectedError | RpcTimeoutError> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkIn(call, scope);
    const exit = yield* Fiber.await(fiber).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(options.timeoutMs),
        onTimeout: () =>
          new RpcTimeoutError({
            method: options.method,
            timeoutMs: options.timeoutMs,
          }),
      }),
    );
    if (Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)) {
      return yield* Effect.fail(makeNotConnectedError());
    }
    return yield* exit;
  }).pipe(Effect.withSpan("callWithTimeout"));

interface ClientConnection<Rpcs extends ProtocolRpc, Client> {
  readonly write: (
    chunk: string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly readerFiber: Fiber.RuntimeFiber<void, Socket.SocketError>;
  readonly scope: Scope.CloseableScope;
  readonly client: Client;
  readonly handshakeSettled: Deferred.Deferred<
    ConnectResult,
    ClientConnectError<Rpcs>
  >;
}

export interface ClientLifecycleOptions<
  Rpcs extends ProtocolRpc,
  Client extends TypedDispatchMap<Rpcs, RpcClientError>,
> {
  readonly serverUrl: string;
  readonly connectTag: ConnectTag<Rpcs>;
  readonly connectPayload: PayloadForTag<Rpcs, ConnectTag<Rpcs>>;
  readonly openSession: (
    options: ClientSocketSessionOptions<Rpcs>,
  ) => Effect.Effect<
    ClientConnection<Rpcs, Client>,
    NotConnectedError,
    Socket.WebSocketConstructor
  >;
  readonly callbackHandlers: () => ReverseCallbackHandlers;
  readonly onDisconnect?: (close: CloseInfo) => void;
  readonly onReconnect?: (helloOk: ConnectResult) => void;
  readonly failConnectWhenClosed: boolean;
}

interface ClientSocketSessionOptions<Rpcs extends ProtocolRpc> {
  readonly serverUrl: string;
  readonly registry: SubscriberRegistry;
  readonly callbackHandlers: ReverseCallbackHandlers;
  readonly handshakeSettled: Deferred.Deferred<
    ConnectResult,
    ClientConnectError<Rpcs>
  >;
  readonly forkReader: (
    effect: Effect.Effect<void, Socket.SocketError>,
  ) => Fiber.RuntimeFiber<void, Socket.SocketError>;
  readonly onReaderExit: (
    exit: Exit.Exit<void, Socket.SocketError>,
    scope: Scope.CloseableScope,
  ) => Effect.Effect<void>;
}

type AgentCallableRpcs = RpcGroup.Rpcs<typeof AgentCallableGroup>;
type AppCallableRpcs = RpcGroup.Rpcs<typeof AppCallableGroup>;
type AgentClientDispatch = TypedDispatchMap<AgentCallableRpcs, RpcClientError>;
type AppClientDispatch = TypedDispatchMap<AppCallableRpcs, RpcClientError>;
type SubscriberRegistry = NotificationSubscriberRegistry<
  NotConnectedError,
  AnyNotificationDefinition
>;
type ReverseCallbackDefinition = (typeof appCallbackMethods)[number];

export type ReverseCallbackHandlers = {
  readonly [D in ReverseCallbackDefinition as D["name"]]: Rpc.ToHandlerFn<
    D["clientRpc"],
    never
  >;
};

type NotificationHandlersFor<D extends AnyNotificationDefinition> = {
  readonly [Definition in D as Definition["name"]]: Rpc.ToHandlerFn<
    Definition["notificationRpc"],
    never
  >;
};
type ReverseNotificationHandlers =
  NotificationHandlersFor<AnyNotificationDefinition>;

type IdentityNotificationDefinition =
  | typeof ContactRequestNotificationDefinition
  | typeof ContactAcceptedNotificationDefinition;
type TaskNotificationDefinition =
  | typeof MessageReceivedNotificationDefinition
  | typeof TaskClosedNotificationDefinition
  | typeof TaskCreatedNotificationDefinition
  | typeof TaskFailedNotificationDefinition
  | typeof TaskConversationCreatedNotificationDefinition
  | typeof TaskConversationArchivedNotificationDefinition
  | typeof TaskConversationUnarchivedNotificationDefinition
  | typeof TaskConversationParticipantsAddedNotificationDefinition
  | typeof TaskConversationParticipantsRemovedNotificationDefinition;
type DispatchNotificationDefinition =
  | typeof DispatchRelease
  | typeof DispatchesConsumed
  | typeof DispatchesExpired;

type NetworkNotificationHandlers = NotificationHandlersFor<
  typeof PresenceChangedNotificationDefinition
>;
type IdentityNotificationHandlers =
  NotificationHandlersFor<IdentityNotificationDefinition>;
type TaskNotificationHandlers =
  NotificationHandlersFor<TaskNotificationDefinition>;
type DispatchNotificationHandlers =
  NotificationHandlersFor<DispatchNotificationDefinition>;

type NotificationHandlerDefinition =
  | typeof PresenceChangedNotificationDefinition
  | IdentityNotificationDefinition
  | TaskNotificationDefinition
  | DispatchNotificationDefinition;
type ExpectTrue<T extends true> = T;
type _NotificationCatalogCoversAll = ExpectTrue<
  Exclude<
    AnyNotificationDefinition,
    NotificationHandlerDefinition
  > extends never
    ? true
    : false
>;
type _NotificationCatalogHasNoExtra = ExpectTrue<
  Exclude<
    NotificationHandlerDefinition,
    AnyNotificationDefinition
  > extends never
    ? true
    : false
>;

type ReverseHandlers = ReverseCallbackHandlers & ReverseNotificationHandlers;

const buildSocketRpcClient = <Rpcs extends Rpc.Any>(options: {
  readonly group: RpcGroup.RpcGroup<Rpcs>;
  readonly write: WireWrite;
  readonly scope: Scope.Scope;
}): Effect.Effect<{
  readonly client: RpcClient.RpcClient<Rpcs, RpcClientError>;
  readonly sink: ChannelSink;
}> =>
  Effect.gen(function* () {
    const sinkReady = yield* Deferred.make<ChannelSink>();
    const builder = makeClientChannelProtocol({
      write: options.write,
    });
    const protocolLayer = Layer.scoped(
      RpcClient.Protocol,
      RpcClient.Protocol.make((write) =>
        builder(write).pipe(
          Effect.tap((built) => Deferred.succeed(sinkReady, built.sink)),
          Effect.map((built) => built.impl),
        ),
      ),
    );
    const client = yield* RpcClient.make(options.group).pipe(
      Effect.provide(protocolLayer),
      Scope.extend(options.scope),
    );
    const sink = yield* Deferred.await(sinkReady);
    return { client, sink };
  }).pipe(Effect.withSpan("buildSocketRpcClient"));

const notificationHandler =
  <D extends AnyNotificationDefinition>(
    registry: SubscriberRegistry,
    definition: D,
  ) =>
  (params: NotificationParamsOf<D>): Effect.Effect<void, never> =>
    registry.dispatch({
      definition,
      method: definition.name,
      params,
    });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const tagOf = (value: unknown): unknown => asObject(value)?.["_tag"];

const taggedErrorFromCause = (frame: Record<string, unknown>): unknown => {
  const error = asObject(frame["error"]);
  if (error === undefined || error["_tag"] !== "Cause") return undefined;
  const cause = asObject(error["data"]);
  if (cause === undefined || cause["_tag"] !== "Fail") return undefined;
  const tagged = cause["error"];
  return typeof tagOf(tagged) === "string" ? tagged : undefined;
};

const flattenReverseErrors =
  (write: WireWrite): WireWrite =>
  (chunk) => {
    if (!chunk.includes("Cause")) return write(chunk);
    const rewritten = rewriteCauseFrame(chunk);
    return write(rewritten ?? chunk);
  };

const rewriteCauseFrame = (chunk: string): string | undefined => {
  const frame = asObject(parseJson(chunk));
  if (frame === undefined) return undefined;
  const tagged = taggedErrorFromCause(frame);
  if (tagged === undefined) return undefined;
  return JSON.stringify({ ...frame, error: tagged });
};

const parseJson = (raw: string): unknown =>
  Effect.runSync(
    Effect.try((): unknown => JSON.parse(raw)).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );

const buildReverseHandlers = (options: {
  readonly registry: SubscriberRegistry;
  readonly callbackHandlers: ReverseCallbackHandlers;
}): ReverseHandlers => ({
  ...options.callbackHandlers,
  ...buildNotificationHandlers(options.registry),
});

const buildNetworkNotificationHandlers = (
  registry: SubscriberRegistry,
): NetworkNotificationHandlers => ({
  [PresenceChangedNotificationDefinition.name]: notificationHandler(
    registry,
    PresenceChangedNotificationDefinition,
  ),
});

const buildIdentityNotificationHandlers = (
  registry: SubscriberRegistry,
): IdentityNotificationHandlers => ({
  [ContactRequestNotificationDefinition.name]: notificationHandler(
    registry,
    ContactRequestNotificationDefinition,
  ),
  [ContactAcceptedNotificationDefinition.name]: notificationHandler(
    registry,
    ContactAcceptedNotificationDefinition,
  ),
});

const buildTaskNotificationHandlers = (
  registry: SubscriberRegistry,
): TaskNotificationHandlers => ({
  [MessageReceivedNotificationDefinition.name]: notificationHandler(
    registry,
    MessageReceivedNotificationDefinition,
  ),
  [TaskClosedNotificationDefinition.name]: notificationHandler(
    registry,
    TaskClosedNotificationDefinition,
  ),
  [TaskCreatedNotificationDefinition.name]: notificationHandler(
    registry,
    TaskCreatedNotificationDefinition,
  ),
  [TaskFailedNotificationDefinition.name]: notificationHandler(
    registry,
    TaskFailedNotificationDefinition,
  ),
  [TaskConversationCreatedNotificationDefinition.name]: notificationHandler(
    registry,
    TaskConversationCreatedNotificationDefinition,
  ),
  [TaskConversationArchivedNotificationDefinition.name]: notificationHandler(
    registry,
    TaskConversationArchivedNotificationDefinition,
  ),
  [TaskConversationUnarchivedNotificationDefinition.name]: notificationHandler(
    registry,
    TaskConversationUnarchivedNotificationDefinition,
  ),
  [TaskConversationParticipantsAddedNotificationDefinition.name]:
    notificationHandler(
      registry,
      TaskConversationParticipantsAddedNotificationDefinition,
    ),
  [TaskConversationParticipantsRemovedNotificationDefinition.name]:
    notificationHandler(
      registry,
      TaskConversationParticipantsRemovedNotificationDefinition,
    ),
});

const buildDispatchNotificationHandlers = (
  registry: SubscriberRegistry,
): DispatchNotificationHandlers => ({
  [DispatchRelease.name]: notificationHandler(registry, DispatchRelease),
  [DispatchesConsumed.name]: notificationHandler(registry, DispatchesConsumed),
  [DispatchesExpired.name]: notificationHandler(registry, DispatchesExpired),
});

const buildNotificationHandlers = (
  registry: SubscriberRegistry,
): ReverseNotificationHandlers => ({
  ...buildNetworkNotificationHandlers(registry),
  ...buildIdentityNotificationHandlers(registry),
  ...buildTaskNotificationHandlers(registry),
  ...buildDispatchNotificationHandlers(registry),
});

const buildReverseRpcServer = (options: {
  readonly registry: SubscriberRegistry;
  readonly callbackHandlers: ReverseCallbackHandlers;
  readonly write: WireWrite;
  readonly scope: Scope.Scope;
}): Effect.Effect<{ readonly sink: ChannelSink }> =>
  Effect.gen(function* () {
    const sinkReady = yield* Deferred.make<ChannelSink>();
    const disconnects = yield* Mailbox.make<number>();
    const protocolLayer = makeServerProtocolLayer({
      write: flattenReverseErrors(options.write),
      disconnects,
      sinkReady,
    });
    const handlers = buildReverseHandlers(options);
    const engineLayer = RpcServer.layer(ReverseRpcGroup).pipe(
      Layer.provide(ReverseRpcGroup.toLayer(handlers)),
      Layer.provide(protocolLayer),
    );
    yield* Layer.build(engineLayer).pipe(Scope.extend(options.scope));
    const sink = yield* Deferred.await(sinkReady);
    return { sink };
  }).pipe(Effect.withSpan("buildReverseRpcServer"));

const openClientSocketSession = <Rpcs extends ProtocolRpc>(
  options: ClientSocketSessionOptions<Rpcs> & {
    readonly group: RpcGroup.RpcGroup<Rpcs>;
  },
): Effect.Effect<
  ClientConnection<Rpcs, RpcClient.RpcClient<Rpcs, RpcClientError>>,
  NotConnectedError,
  Socket.WebSocketConstructor
> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const socket = yield* openSocket(webSocketUrl(options.serverUrl), scope);
    const write = yield* Scope.extend(socket.writer, scope);
    const wireWrite: WireWrite = (chunk) => write(chunk);

    const outbound = yield* buildSocketRpcClient({
      group: options.group,
      write: wireWrite,
      scope,
    });
    const reverse = yield* buildReverseRpcServer({
      registry: options.registry,
      callbackHandlers: options.callbackHandlers,
      write: wireWrite,
      scope,
    });

    const disconnects = yield* Mailbox.make<number>();
    const readerFiber = options.forkReader(
      runMuxReader(
        socket,
        { client: outbound.sink, server: reverse.sink },
        disconnects,
      ).pipe(Effect.onExit((exit) => options.onReaderExit(exit, scope))),
    );

    return {
      write,
      readerFiber,
      scope,
      client: outbound.client,
      handshakeSettled: options.handshakeSettled,
    };
  }).pipe(Effect.withSpan("openProtocolClientSocket"));

export const openProtocolAgentClientSocket = (
  options: ClientSocketSessionOptions<AgentCallableRpcs>,
): Effect.Effect<
  ClientConnection<AgentCallableRpcs, AgentClientDispatch>,
  NotConnectedError,
  Socket.WebSocketConstructor
> =>
  openClientSocketSession({
    ...options,
    group: AgentCallableGroup,
  });

export const openProtocolAppClientSocket = (
  options: ClientSocketSessionOptions<AppCallableRpcs>,
): Effect.Effect<
  ClientConnection<AppCallableRpcs, AppClientDispatch>,
  NotConnectedError,
  Socket.WebSocketConstructor
> =>
  openClientSocketSession({
    ...options,
    group: AppCallableGroup,
  });

class ReconnectAttemptFailedError extends Data.TaggedError(
  "ReconnectAttemptFailedError",
)<{
  readonly reason: string;
}> {}

const makeReconnectSchedule = () =>
  Schedule.exponential(
    Duration.millis(BASE_RECONNECT_DELAY_MS),
    RECONNECT_BACKOFF_FACTOR,
  ).pipe(
    Schedule.either(Schedule.spaced(Duration.millis(MAX_RECONNECT_DELAY_MS))),
    Schedule.jittered,
  );

const makeReconnectLoop = <HelloOk>(input: {
  readonly connectEffect: () => Effect.Effect<
    HelloOk,
    unknown,
    Socket.WebSocketConstructor
  >;
  readonly onReconnect: (helloOk: HelloOk) => void;
  readonly onLoopEnd: () => void;
}): Effect.Effect<void, never> => {
  const attempt = input.connectEffect().pipe(
    Effect.tap((helloOk) =>
      Effect.gen(function* () {
        try {
          input.onReconnect(helloOk);
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
  return attempt.pipe(
    Effect.retry(makeReconnectSchedule()),
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
    Effect.ensuring(Effect.sync(input.onLoopEnd)),
    Effect.provide(NodeSocket.layerWebSocketConstructor),
    Effect.withSpan("makeReconnectLoop"),
  );
};

export class ProtocolClientLifecycle<
  Rpcs extends ProtocolRpc,
  Client extends TypedDispatchMap<Rpcs, RpcClientError>,
> {
  private readonly stateRef: Ref.Ref<
    Option.Option<ClientConnection<Rpcs, Client>>
  >;
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Socket.WebSocketConstructor,
    never
  >;
  private readonly subscribers: SubscriberRegistry;
  private closed = false;
  private reconnectFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private _helloOk: ConnectResult | null = null;

  protected constructor(
    private readonly options: ClientLifecycleOptions<Rpcs, Client>,
  ) {
    this.runtime = ManagedRuntime.make(NodeSocket.layerWebSocketConstructor);
    this.stateRef = this.runtime.runSync(
      Ref.make<Option.Option<ClientConnection<Rpcs, Client>>>(Option.none()),
    );
    this.subscribers = this.runtime.runSync(
      makeNotificationSubscriberRegistry<
        NotConnectedError,
        AnyNotificationDefinition
      >({
        closeCause: makeNotConnectedError,
        logPrefix: "subscriber",
        spanName: "makeSubscriberRegistry",
      }),
    );
  }

  get helloOk(): ConnectResult | null {
    return this._helloOk;
  }

  connect(): Effect.Effect<ConnectResult, ClientConnectError<Rpcs>> {
    return Effect.suspend(() => {
      if (this.closed && this.options.failConnectWhenClosed) {
        return Effect.fail(makeNotConnectedError());
      }
      return this.connectEffect().pipe(
        Effect.provide(NodeSocket.layerWebSocketConstructor),
      );
    });
  }

  subscribe<
    D extends AnyNotificationDefinition,
    R extends NotificationParamsOf<D>,
  >(
    definition: D,
    refinement: (params: NotificationParamsOf<D>) => params is R,
  ): Stream.Stream<R, NotConnectedError, never>;
  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<NotificationParamsOf<D>, NotConnectedError, never>;
  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<NotificationParamsOf<D>, NotConnectedError, never> {
    if (refinement === undefined) {
      return notificationSubscribe(this.subscribers, definition);
    }
    return notificationSubscribe(this.subscribers, definition, refinement);
  }

  subscribeAll(
    refinement?: (
      definition: AnyNotificationDefinition,
      params: NotificationParamsOf<AnyNotificationDefinition>,
    ) => boolean,
  ): Stream.Stream<
    NotificationDelivery<AnyNotificationDefinition>,
    NotConnectedError,
    never
  > {
    if (refinement === undefined) {
      return notificationSubscribeAll(this.subscribers);
    }
    const deliveryRefinement = (
      delivery: NotificationDelivery<AnyNotificationDefinition>,
    ): boolean => {
      return refinement(delivery.definition, delivery.params);
    };
    return notificationSubscribeAll(this.subscribers, deliveryRefinement);
  }

  close(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (this.closed) return;
      const hasCompletedHandshake = this._helloOk !== null;
      this.closed = true;
      this._helloOk = null;
      if (this.reconnectFiber !== null) {
        const f = this.reconnectFiber;
        this.reconnectFiber = null;
        this.runtime.runFork(Fiber.interrupt(f));
      }
      const state = this.runtime.runSync(
        Ref.getAndSet(this.stateRef, Option.none()),
      );
      const drainConnection = Option.isSome(state)
        ? drainConnectionEffect({
            write: state.value.write,
            scope: state.value.scope,
            hasCompletedHandshake,
          })
        : Effect.void;
      this.runtime.runFork(
        this.subscribers.closeAll.pipe(
          Effect.zipRight(drainConnection),
          Effect.ensuring(Effect.sync(() => this.runtime.dispose())),
        ),
      );
    });
  }

  disconnect(): Effect.Effect<void, never> {
    return Effect.sync(() => this.disconnectSync());
  }

  protected callEffect<Tag extends Rpcs["_tag"]>(
    tag: Tag,
    payload: PayloadForTag<Rpcs, Tag>,
    timeoutMs: number,
  ): Effect.Effect<
    SuccessForTag<Rpcs, Tag>,
    ErrorForTag<Rpcs, Tag> | NotConnectedError | RpcTimeoutError
  > {
    return Ref.get(this.stateRef).pipe(
      Effect.flatMap((state) => {
        if (Option.isNone(state)) return Effect.fail(makeNotConnectedError());
        return callWithTimeout(
          state.value.scope,
          makeTypedTransportCall(state.value.client, makeNotConnectedError)(
            tag,
            payload,
          ),
          { method: tag, timeoutMs },
        );
      }),
    );
  }

  callDefinition<D extends ClientRpcDefinition<Rpcs>>(
    definition: D,
    payload: ClientDefinitionPayload<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ClientDefinitionSuccess<D>, ClientDefinitionError<D>> {
    const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
    return this.callRpcMember(definition.clientRpc, payload, timeoutMs);
  }

  private callRpcMember<Member extends Rpcs>(
    member: Member,
    payload: Rpc.PayloadConstructor<Member>,
    timeoutMs: number,
  ): Effect.Effect<
    Rpc.Success<Member>,
    Rpc.Error<Member> | NotConnectedError | RpcTimeoutError
  > {
    return this.callEffect(member._tag, payload, timeoutMs);
  }

  private disconnectSync(): void {
    const state = this.runtime.runSync(Ref.get(this.stateRef));
    if (Option.isNone(state)) return;
    this.runtime.runSync(Ref.set(this.stateRef, Option.none()));
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
    ClientConnectError<Rpcs>,
    Socket.WebSocketConstructor
  > {
    return Effect.gen(this, function* () {
      const handshakeSettled = yield* Deferred.make<
        ConnectResult,
        ClientConnectError<Rpcs>
      >();
      const session = yield* this.options.openSession({
        serverUrl: this.options.serverUrl,
        registry: this.subscribers,
        callbackHandlers: this.options.callbackHandlers(),
        handshakeSettled,
        forkReader: (effect) => this.runtime.runFork(effect),
        onReaderExit: (exit, scope) =>
          this.handleReaderExit(exit, handshakeSettled, scope),
      });

      yield* Ref.set(this.stateRef, Option.some(session));
      return yield* this.awaitConnectAuth(handshakeSettled);
    });
  }

  private handleReaderExit(
    exit: Exit.Exit<void, Socket.SocketError>,
    handshakeSettled: Deferred.Deferred<
      ConnectResult,
      ClientConnectError<Rpcs>
    >,
    scope: Scope.CloseableScope,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const closeInfo = extractCloseInfo(exit);
      if (
        Exit.isFailure(exit) &&
        closeInfo.code !== DEFAULT_GRACEFUL_CLOSE.code
      ) {
        yield* Effect.logWarning("WebSocket error", exit.cause);
      }
      this._helloOk = null;
      yield* Deferred.fail(handshakeSettled, makeNotConnectedError()).pipe(
        Effect.ignore,
      );
      yield* Ref.set(this.stateRef, Option.none());
      yield* Scope.close(scope, Exit.void);
      yield* this.notifyDisconnect(closeInfo);
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private awaitConnectAuth(
    handshakeSettled: Deferred.Deferred<
      ConnectResult,
      ClientConnectError<Rpcs>
    >,
  ): Effect.Effect<ConnectResult, ClientConnectError<Rpcs>> {
    const authEffect = this.callEffect(
      this.options.connectTag,
      this.options.connectPayload,
      RPC_TIMEOUT_MS,
    );
    return Effect.raceFirst(authEffect, Deferred.await(handshakeSettled)).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          this._helloOk = value;
        }),
      ),
    );
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectFiber !== null) return;
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
