/* eslint-disable max-lines -- lifecycle state and scope ownership stay together so every socket-closing transition remains auditable */
import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { RpcClient, RpcServer, type Rpc, type RpcGroup } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  Layer,
  Mailbox,
  ManagedRuntime,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  AgentConnect,
  AppConnect,
  ServerBaseUrl,
  webSocketUrl,
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
  DispatchLeaseConsumed,
  DispatchLeaseExpired,
} from "#message/dispatch";
import {
  ContactAcceptedNotificationDefinition,
  ContactRequestNotificationDefinition,
} from "#identity/contacts";
import { MessageReceivedNotificationDefinition } from "#message";
import {
  ConversationArchivedNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationParticipantsAddedNotificationDefinition,
  ConversationParticipantsRemovedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
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
import { clientRuntimeLoggerLayer } from "./client-runtime.config.js";
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

const WEB_SOCKET_OPEN_TIMEOUT_SECONDS = 10;
const NORMAL_CLOSE_CODE = 1000;
const GRACEFUL_CLOSE_WRITE_TIMEOUT = Duration.seconds(1);
const MSG_NOT_CONNECTED = "WebSocket not connected";
const SCOPED_SUBSCRIPTION_CAPACITY = 1_024;

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

const decodeServerBaseUrl = Schema.decodeEither(ServerBaseUrl);

// Callers reach the lifecycle across a package boundary with a plain string,
// so the address is decoded here rather than trusted.
const socketUrl = (
  serverUrl: string,
): Effect.Effect<string, NotConnectedError> =>
  Either.match(decodeServerBaseUrl(serverUrl), {
    onLeft: (error) =>
      Effect.fail(new NotConnectedError({ message: error.message })),
    onRight: (base) => Effect.succeed(webSocketUrl(base)),
  });

const makeSocket = (
  url: string,
): Effect.Effect<ClientWebSocket, never, Socket.WebSocketConstructor> => {
  const openTimeout = Duration.seconds(WEB_SOCKET_OPEN_TIMEOUT_SECONDS);
  return Socket.makeWebSocket(url, { openTimeout });
};

const requestGracefulClose = (input: {
  readonly write: (
    chunk: Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly hasCompletedHandshake: boolean;
}): Effect.Effect<void> => {
  if (!input.hasCompletedHandshake) return Effect.void;
  return input
    .write(new Socket.CloseEvent(NORMAL_CLOSE_CODE, "normal"))
    .pipe(Effect.timeout(GRACEFUL_CLOSE_WRITE_TIMEOUT), Effect.ignore);
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

interface ClientConnection<Client> {
  readonly write: (
    chunk: string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly reader: Effect.Effect<void, Socket.SocketError>;
  readonly scope: Scope.Scope;
  readonly client: Client;
}

export interface ClientLifecycleOptions<
  Rpcs extends ProtocolRpc,
  Client extends TypedDispatchMap<Rpcs, RpcClientError>,
> {
  readonly serverUrl: string;
  readonly connectTag: ConnectTag<Rpcs>;
  readonly connectPayload: PayloadForTag<Rpcs, ConnectTag<Rpcs>>;
  readonly openSession: (
    options: ClientSocketSessionOptions,
  ) => Effect.Effect<
    ClientConnection<Client>,
    NotConnectedError,
    Socket.WebSocketConstructor
  >;
  readonly callbackHandlers: () => ReverseCallbackHandlers;
  readonly onDisconnect?: (close: CloseInfo) => void;
}

interface ClientSocketSessionOptions {
  readonly serverUrl: string;
  readonly registry: SubscriberRegistry;
  readonly callbackHandlers: ReverseCallbackHandlers;
  readonly scope?: Scope.Scope;
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
  | typeof ConversationCreatedNotificationDefinition
  | typeof ConversationArchivedNotificationDefinition
  | typeof ConversationUnarchivedNotificationDefinition
  | typeof ConversationParticipantsAddedNotificationDefinition
  | typeof ConversationParticipantsRemovedNotificationDefinition;
type DispatchNotificationDefinition =
  | typeof DispatchRelease
  | typeof DispatchLeaseConsumed
  | typeof DispatchLeaseExpired;

type IdentityNotificationHandlers =
  NotificationHandlersFor<IdentityNotificationDefinition>;
type TaskNotificationHandlers =
  NotificationHandlersFor<TaskNotificationDefinition>;
type DispatchNotificationHandlers =
  NotificationHandlersFor<DispatchNotificationDefinition>;

type NotificationHandlerDefinition =
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
  [ConversationCreatedNotificationDefinition.name]: notificationHandler(
    registry,
    ConversationCreatedNotificationDefinition,
  ),
  [ConversationArchivedNotificationDefinition.name]: notificationHandler(
    registry,
    ConversationArchivedNotificationDefinition,
  ),
  [ConversationUnarchivedNotificationDefinition.name]: notificationHandler(
    registry,
    ConversationUnarchivedNotificationDefinition,
  ),
  [ConversationParticipantsAddedNotificationDefinition.name]:
    notificationHandler(
      registry,
      ConversationParticipantsAddedNotificationDefinition,
    ),
  [ConversationParticipantsRemovedNotificationDefinition.name]:
    notificationHandler(
      registry,
      ConversationParticipantsRemovedNotificationDefinition,
    ),
});

const buildDispatchNotificationHandlers = (
  registry: SubscriberRegistry,
): DispatchNotificationHandlers => ({
  [DispatchRelease.name]: notificationHandler(registry, DispatchRelease),
  [DispatchLeaseConsumed.name]: notificationHandler(
    registry,
    DispatchLeaseConsumed,
  ),
  [DispatchLeaseExpired.name]: notificationHandler(
    registry,
    DispatchLeaseExpired,
  ),
});

const buildNotificationHandlers = (
  registry: SubscriberRegistry,
): ReverseNotificationHandlers => ({
  ...buildIdentityNotificationHandlers(registry),
  ...buildTaskNotificationHandlers(registry),
  ...buildDispatchNotificationHandlers(registry),
});

const buildReverseRpcServer = (options: {
  readonly registry: SubscriberRegistry;
  readonly callbackHandlers: ReverseCallbackHandlers;
  readonly write: WireWrite;
  readonly disconnects: Mailbox.Mailbox<number>;
  readonly scope: Scope.Scope;
}): Effect.Effect<{ readonly sink: ChannelSink }> =>
  Effect.gen(function* () {
    const sinkReady = yield* Deferred.make<ChannelSink>();
    const protocolLayer = makeServerProtocolLayer({
      write: flattenReverseErrors(options.write),
      disconnects: options.disconnects,
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

type GroupedClientSocketSessionOptions<Rpcs extends ProtocolRpc> =
  ClientSocketSessionOptions & {
    readonly group: RpcGroup.RpcGroup<Rpcs>;
  };

const openClientSocketSession = <Rpcs extends ProtocolRpc>(
  options: GroupedClientSocketSessionOptions<Rpcs>,
): Effect.Effect<
  ClientConnection<RpcClient.RpcClient<Rpcs, RpcClientError>>,
  NotConnectedError,
  Socket.WebSocketConstructor
> =>
  Effect.gen(function* () {
    const url = yield* socketUrl(options.serverUrl);
    const scope = options.scope ?? (yield* Scope.make());
    const socket = yield* makeSocket(url);
    const write = yield* Scope.extend(socket.writer, scope);
    const wireWrite: WireWrite = (chunk) => write(chunk);
    const outbound = yield* buildSocketRpcClient({
      group: options.group,
      write: wireWrite,
      scope,
    });
    const disconnects = yield* Mailbox.make<number>();
    const reverse = yield* buildReverseRpcServer({
      registry: options.registry,
      callbackHandlers: options.callbackHandlers,
      write: wireWrite,
      disconnects,
      scope,
    });
    return {
      write,
      scope,
      client: outbound.client,
      reader: runMuxReader(
        socket,
        { client: outbound.sink, server: reverse.sink },
        disconnects,
      ),
    };
  }).pipe(Effect.withSpan("openProtocolClientSocket"));

export const openProtocolAgentClientSocket = (
  options: ClientSocketSessionOptions,
): Effect.Effect<
  ClientConnection<AgentClientDispatch>,
  NotConnectedError,
  Socket.WebSocketConstructor
> =>
  openClientSocketSession({
    ...options,
    group: AgentCallableGroup,
  });

export const openProtocolAppClientSocket = (
  options: ClientSocketSessionOptions,
): Effect.Effect<
  ClientConnection<AppClientDispatch>,
  NotConnectedError,
  Socket.WebSocketConstructor
> =>
  openClientSocketSession({
    ...options,
    group: AppCallableGroup,
  });

type ConnectWaiter<Rpcs extends ProtocolRpc> = Deferred.Deferred<
  ConnectResult,
  ClientConnectError<Rpcs>
>;

interface ClientGeneration<Rpcs extends ProtocolRpc> {
  readonly token: object;
  readonly owner: Fiber.RuntimeFiber<void, never>;
  readonly connectWaiters: Array<ConnectWaiter<Rpcs>>;
  readonly disconnectWaiters: Array<Deferred.Deferred<void, never>>;
}

type ClientLifecycleState<
  Rpcs extends ProtocolRpc,
  Client extends TypedDispatchMap<Rpcs, RpcClientError>,
> =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Opening";
      readonly generation: ClientGeneration<Rpcs>;
    }
  | {
      readonly _tag: "Connected";
      readonly generation: ClientGeneration<Rpcs>;
      readonly connection: ClientConnection<Client>;
    }
  | {
      readonly _tag: "Stopping";
      readonly generation: ClientGeneration<Rpcs>;
      readonly terminal: boolean;
    }
  | { readonly _tag: "Stopped" };

type ClientLifecycleCommand<
  Rpcs extends ProtocolRpc,
  Client extends TypedDispatchMap<Rpcs, RpcClientError>,
> =
  | {
      readonly _tag: "Connect";
      readonly reply: ConnectWaiter<Rpcs>;
    }
  | {
      readonly _tag: "SessionOpened";
      readonly token: object;
      readonly connection: ClientConnection<Client>;
      readonly startReader: Deferred.Deferred<void, never>;
    }
  | {
      readonly _tag: "AuthenticationSettled";
      readonly token: object;
      readonly exit: Exit.Exit<ConnectResult, ClientConnectError<Rpcs>>;
    }
  | {
      readonly _tag: "ReaderExited";
      readonly token: object;
      readonly exit: Exit.Exit<void, Socket.SocketError>;
      readonly close: CloseInfo;
      readonly acknowledged: Deferred.Deferred<void, never>;
    }
  | {
      readonly _tag: "OwnerDone";
      readonly token: object;
      readonly openError: NotConnectedError | null;
    }
  | {
      readonly _tag: "Disconnect";
      readonly acknowledged: Deferred.Deferred<void, never>;
    }
  | {
      readonly _tag: "Close";
      readonly hasCompletedHandshake: boolean;
    };

/**
 * Serializes connection generations through one controller. Each generation
 * has one scoped owner that acquires the socket, runs its reader, and reports
 * `OwnerDone` only after every session finalizer has completed. The start gate
 * prevents an acquired reader from running unless its generation is still
 * current.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Idle
 *   Idle --> Opening: Connect
 *   Opening --> Connected: SessionOpened starts reader and authentication
 *   Opening --> Idle: OwnerDone after opening failure
 *   Opening --> Stopping: Close interrupts owner
 *   Connected --> Stopping: ReaderExited
 *   Connected --> Stopping: Close or disconnect interrupts owner
 *   Stopping --> Idle: OwnerDone permits explicit connect
 *   Stopping --> Stopped: OwnerDone completes terminal close
 * ```
 */
export class ProtocolClientLifecycle<
  Rpcs extends ProtocolRpc,
  Client extends TypedDispatchMap<Rpcs, RpcClientError>,
> {
  private readonly connectionRef: Ref.Ref<ClientConnection<Client> | null>;
  private readonly commands: Mailbox.Mailbox<
    ClientLifecycleCommand<Rpcs, Client>
  >;
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Socket.WebSocketConstructor,
    never
  >;
  private readonly subscribers: SubscriberRegistry;
  private readonly controllerDone: Deferred.Deferred<void, never>;
  private readonly closeCompletion: Deferred.Deferred<void, never>;
  private closed = false;
  private _helloOk: ConnectResult | null = null;

  protected constructor(
    private readonly options: ClientLifecycleOptions<Rpcs, Client>,
  ) {
    this.runtime = ManagedRuntime.make(
      Layer.merge(
        NodeSocket.layerWebSocketConstructor,
        clientRuntimeLoggerLayer,
      ),
    );
    const initialized = this.runtime.runSync(
      Effect.gen(function* () {
        const connectionRef = yield* Ref.make<ClientConnection<Client> | null>(
          null,
        );
        const commands =
          yield* Mailbox.make<ClientLifecycleCommand<Rpcs, Client>>();
        const subscribers = yield* makeNotificationSubscriberRegistry<
          NotConnectedError,
          AnyNotificationDefinition
        >({
          closeCause: makeNotConnectedError,
          logPrefix: "subscriber",
          spanName: "makeSubscriberRegistry",
        });
        const controllerDone = yield* Deferred.make<void, never>();
        const closeCompletion = yield* Deferred.make<void, never>();
        return {
          connectionRef,
          commands,
          subscribers,
          controllerDone,
          closeCompletion,
        };
      }),
    );
    this.connectionRef = initialized.connectionRef;
    this.commands = initialized.commands;
    this.subscribers = initialized.subscribers;
    this.controllerDone = initialized.controllerDone;
    this.closeCompletion = initialized.closeCompletion;
    this.runtime.runFork(this.runController());
  }

  get helloOk(): ConnectResult | null {
    return this._helloOk;
  }

  connect(): Effect.Effect<ConnectResult, ClientConnectError<Rpcs>> {
    return Effect.suspend(() =>
      this.closed ? Effect.fail(makeNotConnectedError()) : this.connectEffect(),
    );
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

  /**
   * Acquire a notification subscription before exposing its Stream.
   * The returned Stream is ready to receive immediately, and the caller's
   * Scope owns both unregistration and mailbox termination.
   */
  subscribeScoped<D extends AnyNotificationDefinition>(
    definition: D,
  ): Effect.Effect<
    Stream.Stream<NotificationParamsOf<D>, NotConnectedError>,
    never,
    Scope.Scope
  > {
    return Effect.gen(this, function* () {
      const mailbox = yield* Mailbox.make<
        NotificationParamsOf<D>,
        NotConnectedError
      >(SCOPED_SUBSCRIPTION_CAPACITY);
      const subscription = yield* this.subscribers.register(
        definition,
        undefined,
        {
          onFrame: (params) => mailbox.offer(params).pipe(Effect.asVoid),
          onClose: (cause) => mailbox.fail(cause).pipe(Effect.asVoid),
        },
      );
      yield* Effect.addFinalizer(() =>
        subscription.unregister.pipe(
          Effect.zipRight(mailbox.end),
          Effect.asVoid,
        ),
      );
      return Mailbox.toStream(mailbox);
    }).pipe(Effect.withSpan("ProtocolClientLifecycle.subscribeScoped"));
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
    return Effect.uninterruptible(
      Effect.suspend(() => {
        if (this.closed) return Deferred.await(this.closeCompletion);
        const closeCompletion = this.closeCompletion;
        const controllerDone = this.controllerDone;
        const runtime = this.runtime;
        this.closed = true;
        const hasCompletedHandshake = this._helloOk !== null;
        this._helloOk = null;
        this.commands.unsafeOffer({
          _tag: "Close",
          hasCompletedHandshake,
        });
        return Deferred.await(controllerDone).pipe(
          Effect.zipRight(runtime.disposeEffect),
          Effect.ensuring(
            Deferred.succeed(closeCompletion, undefined).pipe(Effect.asVoid),
          ),
        );
      }),
    );
  }

  disconnect(): Effect.Effect<void, never> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(this, function* () {
        if (this.closed) return;
        const acknowledged = yield* Deferred.make<void, never>();
        const offered = yield* Effect.sync(() => {
          if (this.closed) return false;
          return this.commands.unsafeOffer({
            _tag: "Disconnect",
            acknowledged,
          });
        });
        if (!offered) return;
        yield* restore(Deferred.await(acknowledged));
      }),
    );
  }

  protected callEffect<Tag extends Rpcs["_tag"]>(
    tag: Tag,
    payload: PayloadForTag<Rpcs, Tag>,
    timeoutMs: number,
  ): Effect.Effect<
    SuccessForTag<Rpcs, Tag>,
    ErrorForTag<Rpcs, Tag> | NotConnectedError | RpcTimeoutError
  > {
    return Effect.suspend(() => {
      if (this.closed) return Effect.fail(makeNotConnectedError());
      return Ref.get(this.connectionRef).pipe(
        Effect.flatMap((connection) => {
          if (connection === null) return Effect.fail(makeNotConnectedError());
          return callWithTimeout(
            connection.scope,
            makeTypedTransportCall(connection.client, makeNotConnectedError)(
              tag,
              payload,
            ),
            { method: tag, timeoutMs },
          );
        }),
      );
    });
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

  private connectEffect(): Effect.Effect<
    ConnectResult,
    ClientConnectError<Rpcs>
  > {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(this, function* () {
        const reply = yield* Deferred.make<
          ConnectResult,
          ClientConnectError<Rpcs>
        >();
        const offered = yield* Effect.sync(() => {
          if (this.closed) return false;
          return this.commands.unsafeOffer({ _tag: "Connect", reply });
        });
        if (!offered) return yield* Effect.fail(makeNotConnectedError());
        return yield* restore(Deferred.await(reply));
      }),
    );
  }

  private runController(): Effect.Effect<
    void,
    never,
    Socket.WebSocketConstructor
  > {
    return Effect.scoped(this.controllerLoop()).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logError("Protocol client lifecycle controller failed", cause),
      ),
      Effect.ensuring(this.commands.end.pipe(Effect.asVoid)),
      Effect.ensuring(
        Deferred.succeed(this.controllerDone, undefined).pipe(Effect.asVoid),
      ),
    );
  }

  private controllerLoop(): Effect.Effect<
    void,
    never,
    Socket.WebSocketConstructor | Scope.Scope
  > {
    return Effect.gen(this, function* () {
      let state: ClientLifecycleState<Rpcs, Client> = { _tag: "Idle" };
      while (state._tag !== "Stopped") {
        const command = yield* this.commands.take.pipe(Effect.orDie);
        state = yield* this.handleCommand(state, command);
      }
    });
  }

  private handleCommand(
    state: ClientLifecycleState<Rpcs, Client>,
    command: ClientLifecycleCommand<Rpcs, Client>,
  ): Effect.Effect<
    ClientLifecycleState<Rpcs, Client>,
    never,
    Socket.WebSocketConstructor | Scope.Scope
  > {
    switch (command._tag) {
      case "Connect":
        return this.handleConnect(state, command.reply);
      case "SessionOpened":
        return this.handleSessionOpened(state, command);
      case "AuthenticationSettled":
        return this.handleAuthenticationSettled(state, command);
      case "ReaderExited":
        return this.handleReaderExited(state, command);
      case "OwnerDone":
        return this.handleOwnerDone(state, command.token, command.openError);
      case "Disconnect":
        return this.handleDisconnect(state, command.acknowledged);
      case "Close":
        return this.handleClose(state, command.hasCompletedHandshake);
    }
  }

  private handleConnect(
    state: ClientLifecycleState<Rpcs, Client>,
    reply: ConnectWaiter<Rpcs>,
  ): Effect.Effect<
    ClientLifecycleState<Rpcs, Client>,
    never,
    Socket.WebSocketConstructor | Scope.Scope
  > {
    switch (state._tag) {
      case "Idle":
        return Effect.gen(this, function* () {
          const token = {};
          const owner = yield* Effect.forkScoped(
            this.superviseConnection(token),
          );
          return {
            _tag: "Opening",
            generation: {
              token,
              owner,
              connectWaiters: [reply],
              disconnectWaiters: [],
            },
          } satisfies ClientLifecycleState<Rpcs, Client>;
        });
      case "Opening":
        return Effect.sync(() => {
          state.generation.connectWaiters.push(reply);
          return state;
        });
      case "Connected":
        if (this._helloOk !== null) {
          return Deferred.succeed(reply, this._helloOk).pipe(Effect.as(state));
        }
        return Effect.sync(() => {
          state.generation.connectWaiters.push(reply);
          return state;
        });
      case "Stopping":
      case "Stopped":
        return Deferred.fail(reply, makeNotConnectedError()).pipe(
          Effect.as(state),
        );
    }
  }

  private handleSessionOpened(
    state: ClientLifecycleState<Rpcs, Client>,
    command: Extract<
      ClientLifecycleCommand<Rpcs, Client>,
      { readonly _tag: "SessionOpened" }
    >,
  ): Effect.Effect<ClientLifecycleState<Rpcs, Client>, never, Scope.Scope> {
    if (state._tag !== "Opening" || state.generation.token !== command.token) {
      return Deferred.interrupt(command.startReader).pipe(Effect.as(state));
    }
    return Effect.gen(this, function* () {
      yield* Ref.set(this.connectionRef, command.connection);
      yield* Deferred.succeed(command.startReader, undefined);
      yield* Effect.forkScoped(
        this.authenticate(command.token, command.connection),
      );
      return {
        _tag: "Connected",
        generation: state.generation,
        connection: command.connection,
      } satisfies ClientLifecycleState<Rpcs, Client>;
    });
  }

  private handleAuthenticationSettled(
    state: ClientLifecycleState<Rpcs, Client>,
    command: Extract<
      ClientLifecycleCommand<Rpcs, Client>,
      { readonly _tag: "AuthenticationSettled" }
    >,
  ): Effect.Effect<ClientLifecycleState<Rpcs, Client>, never, Scope.Scope> {
    if (
      state._tag !== "Connected" ||
      state.generation.token !== command.token
    ) {
      return Effect.succeed(state);
    }
    if (Exit.isSuccess(command.exit)) {
      const helloOk = command.exit.value;
      return Effect.gen(this, function* () {
        this._helloOk = helloOk;
        yield* this.settleWaiters(state.generation, command.exit);
        return state;
      });
    }
    return Effect.gen(this, function* () {
      this._helloOk = null;
      yield* Ref.set(this.connectionRef, null);
      yield* this.settleWaiters(state.generation, command.exit);
      yield* this.interruptOwner(state.generation.owner);
      return {
        _tag: "Stopping",
        generation: state.generation,
        terminal: false,
      } satisfies ClientLifecycleState<Rpcs, Client>;
    });
  }

  private handleReaderExited(
    state: ClientLifecycleState<Rpcs, Client>,
    command: Extract<
      ClientLifecycleCommand<Rpcs, Client>,
      { readonly _tag: "ReaderExited" }
    >,
  ): Effect.Effect<ClientLifecycleState<Rpcs, Client>> {
    return Effect.gen(this, function* () {
      let next = state;
      if (
        state._tag === "Connected" &&
        state.generation.token === command.token
      ) {
        this._helloOk = null;
        yield* Ref.set(this.connectionRef, null);
        yield* this.failWaiters(state.generation, makeNotConnectedError());
        next = {
          _tag: "Stopping",
          generation: state.generation,
          terminal: this.closed,
        };
      }
      if (
        !this.closed &&
        Exit.isFailure(command.exit) &&
        !Cause.isInterruptedOnly(command.exit.cause) &&
        command.close.code !== DEFAULT_GRACEFUL_CLOSE.code
      ) {
        yield* Effect.logWarning("WebSocket error", command.exit.cause);
      }
      yield* this.notifyDisconnect(command.close);
      return next;
    }).pipe(
      Effect.ensuring(
        Deferred.succeed(command.acknowledged, undefined).pipe(Effect.asVoid),
      ),
    );
  }

  private handleOwnerDone(
    state: ClientLifecycleState<Rpcs, Client>,
    token: object,
    openError: NotConnectedError | null,
  ): Effect.Effect<ClientLifecycleState<Rpcs, Client>, never, Scope.Scope> {
    if (
      state._tag === "Idle" ||
      state._tag === "Stopped" ||
      state.generation.token !== token
    ) {
      return Effect.succeed(state);
    }
    if (state._tag === "Opening") {
      return this.failWaiters(
        state.generation,
        openError ?? makeNotConnectedError(),
      ).pipe(Effect.as({ _tag: "Idle" }));
    }
    if (state._tag === "Connected") {
      return Effect.gen(this, function* () {
        this._helloOk = null;
        yield* Ref.set(this.connectionRef, null);
        yield* this.failWaiters(state.generation, makeNotConnectedError());
        return { _tag: "Idle" } as const;
      });
    }
    return Effect.gen(this, function* () {
      yield* this.completeDisconnects(state.generation);
      if (state.terminal) return { _tag: "Stopped" } as const;
      return { _tag: "Idle" } as const;
    });
  }

  private handleDisconnect(
    state: ClientLifecycleState<Rpcs, Client>,
    acknowledged: Deferred.Deferred<void, never>,
  ): Effect.Effect<ClientLifecycleState<Rpcs, Client>, never, Scope.Scope> {
    switch (state._tag) {
      case "Idle":
      case "Stopped":
        return Deferred.succeed(acknowledged, undefined).pipe(Effect.as(state));
      case "Opening":
        return Effect.gen(this, function* () {
          yield* this.failWaiters(state.generation, makeNotConnectedError());
          state.generation.disconnectWaiters.push(acknowledged);
          yield* this.interruptOwner(state.generation.owner);
          return {
            _tag: "Stopping",
            generation: state.generation,
            terminal: false,
          } satisfies ClientLifecycleState<Rpcs, Client>;
        });
      case "Stopping":
        return Effect.sync(() => {
          state.generation.disconnectWaiters.push(acknowledged);
          return state;
        });
      case "Connected":
        return Effect.gen(this, function* () {
          this._helloOk = null;
          yield* Ref.set(this.connectionRef, null);
          yield* this.failWaiters(state.generation, makeNotConnectedError());
          state.generation.disconnectWaiters.push(acknowledged);
          yield* this.interruptOwner(state.generation.owner);
          return {
            _tag: "Stopping",
            generation: state.generation,
            terminal: false,
          } satisfies ClientLifecycleState<Rpcs, Client>;
        });
    }
  }

  private handleClose(
    state: ClientLifecycleState<Rpcs, Client>,
    hasCompletedHandshake: boolean,
  ): Effect.Effect<ClientLifecycleState<Rpcs, Client>, never, Scope.Scope> {
    return Effect.gen(this, function* () {
      this._helloOk = null;
      yield* Ref.set(this.connectionRef, null);
      yield* this.subscribers.closeAll;

      switch (state._tag) {
        case "Idle":
        case "Stopped":
          return { _tag: "Stopped" } as const;
        case "Opening":
          yield* this.failWaiters(state.generation, makeNotConnectedError());
          yield* this.interruptOwner(state.generation.owner);
          return {
            _tag: "Stopping",
            generation: state.generation,
            terminal: true,
          } satisfies ClientLifecycleState<Rpcs, Client>;
        case "Connected":
          yield* this.failWaiters(state.generation, makeNotConnectedError());
          yield* this.interruptOwner(
            state.generation.owner,
            hasCompletedHandshake ? state.connection : null,
          );
          return {
            _tag: "Stopping",
            generation: state.generation,
            terminal: true,
          } satisfies ClientLifecycleState<Rpcs, Client>;
        case "Stopping":
          return {
            ...state,
            terminal: true,
          };
      }
    });
  }

  private superviseConnection(
    token: object,
  ): Effect.Effect<void, never, Socket.WebSocketConstructor> {
    let openError: NotConnectedError | null = null;
    const session = Effect.scoped(
      this.acquireConnection().pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              openError = error;
            }),
          onSuccess: (connection) =>
            Effect.gen(this, function* () {
              const startReader = yield* Deferred.make<void, never>();
              yield* this.commands.offer({
                _tag: "SessionOpened",
                token,
                connection,
                startReader,
              });
              yield* Deferred.await(startReader);
              yield* connection.reader.pipe(
                Effect.onExit((exit) => this.reportReaderExit(token, exit)),
                Effect.ignore,
              );
            }),
        }),
      ),
    );
    return session.pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          this.commands
            .offer({ _tag: "OwnerDone", token, openError })
            .pipe(Effect.asVoid),
        ),
      ),
      Effect.catchAllCause((cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.void
          : Effect.logError("Connection supervisor failed", cause),
      ),
    );
  }

  private acquireConnection(): Effect.Effect<
    ClientConnection<Client>,
    NotConnectedError,
    Socket.WebSocketConstructor | Scope.Scope
  > {
    return Effect.scopeWith((scope) =>
      this.options.openSession({
        serverUrl: this.options.serverUrl,
        registry: this.subscribers,
        callbackHandlers: this.options.callbackHandlers(),
        scope,
      }),
    );
  }

  private reportReaderExit(
    token: object,
    exit: Exit.Exit<void, Socket.SocketError>,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const acknowledged = yield* Deferred.make<void, never>();
      yield* this.commands.offer({
        _tag: "ReaderExited",
        token,
        exit,
        close: extractCloseInfo(exit),
        acknowledged,
      });
      yield* Deferred.await(acknowledged);
    });
  }

  private authenticate(
    token: object,
    connection: ClientConnection<Client>,
  ): Effect.Effect<void> {
    const call = callWithTimeout(
      connection.scope,
      makeTypedTransportCall(connection.client, makeNotConnectedError)(
        this.options.connectTag,
        this.options.connectPayload,
      ),
      { method: this.options.connectTag, timeoutMs: RPC_TIMEOUT_MS },
    );
    return Effect.exit(call).pipe(
      Effect.flatMap((exit) =>
        this.commands.offer({
          _tag: "AuthenticationSettled",
          token,
          exit,
        }),
      ),
      Effect.asVoid,
    );
  }

  private interruptOwner(
    owner: Fiber.RuntimeFiber<void, never>,
    connection: ClientConnection<Client> | null = null,
  ): Effect.Effect<void, never, Scope.Scope> {
    const cleanup =
      connection === null
        ? Fiber.interrupt(owner)
        : requestGracefulClose({
            write: connection.write,
            hasCompletedHandshake: true,
          }).pipe(Effect.zipRight(Fiber.interrupt(owner)));
    return Effect.forkScoped(cleanup).pipe(Effect.asVoid);
  }

  private settleWaiters(
    generation: ClientGeneration<Rpcs>,
    exit: Exit.Exit<ConnectResult, ClientConnectError<Rpcs>>,
  ): Effect.Effect<void> {
    return Effect.gen(function* () {
      for (const waiter of generation.connectWaiters.splice(0)) {
        yield* Deferred.done(waiter, exit);
      }
    });
  }

  private failWaiters(
    generation: ClientGeneration<Rpcs>,
    error: ClientConnectError<Rpcs>,
  ): Effect.Effect<void> {
    return this.settleWaiters(generation, Exit.fail(error));
  }

  private completeDisconnects(
    generation: ClientGeneration<Rpcs>,
  ): Effect.Effect<void> {
    return Effect.gen(function* () {
      for (const waiter of generation.disconnectWaiters.splice(0)) {
        yield* Deferred.succeed(waiter, undefined);
      }
    });
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
}
