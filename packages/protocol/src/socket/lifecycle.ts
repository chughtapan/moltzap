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
  Match,
  Ref,
  Schema,
  Scope,
  type Stream,
} from "effect";
import {
  type agentConnect,
  type appConnect,
  serverBaseUrlSchema,
  webSocketUrl,
} from "#network";
import {
  agentCallableGroup,
  appCallableGroup,
  reverseRpcGroup,
  type appCallbackMethods,
  type AnyNotificationDefinition,
} from "#socket/catalog";
import {
  dispatchRelease,
  dispatchLeaseConsumed,
  dispatchLeaseExpired,
} from "#message/dispatch";
import { messageReceivedNotificationDefinition } from "#message";
import {
  conversationCreatedNotificationDefinition,
  conversationParticipantsAddedNotificationDefinition,
  conversationParticipantsRemovedNotificationDefinition,
} from "#conversation";
import {
  taskClosedNotificationDefinition,
  taskCreatedNotificationDefinition,
  taskFailedNotificationDefinition,
} from "#task";
import {
  DEFAULT_GRACEFUL_CLOSE,
  extractCloseInfo,
  type CloseInfo,
} from "./close-info.js";
import { clientRuntimeLoggerLayer } from "./client-runtime.config.js";
import {
  type NotificationDelivery,
  type NotificationParamsOf,
  type ResultOf,
  makeNotificationSubscriberRegistry,
  notificationSubscribe,
  notificationSubscribeAll,
  type NotificationSubscriberRegistry,
  NotConnectedError,
  RpcTimeoutError,
  makeClientChannelProtocol,
  runMuxReader,
  type ChannelSink,
  type WireWrite,
  makeTypedTransportCall,
  type ErrorForTag,
  type PayloadForTag,
  type SuccessForTag,
  type TypedDispatchMap,
} from "#transport";
import { makeServerProtocolLayer } from "./internal/protocol-layer.js";

/** Provides the rpc timeout ms runtime value. */
export const RPC_TIMEOUT_MS = 30_000;

const WEB_SOCKET_OPEN_TIMEOUT_SECONDS = 10;
const NORMAL_CLOSE_CODE = 1000;
const GRACEFUL_CLOSE_WRITE_TIMEOUT = Duration.seconds(1);
const MSG_NOT_CONNECTED = "WebSocket not connected";
const SCOPED_SUBSCRIPTION_CAPACITY = 1_024;

/** Configures rpc call. */
export interface RpcCallOptions {
  readonly timeoutMs?: number;
}

/** Describes client rpc definition. */
export interface ClientRpcDefinition<Rpcs extends Rpc.Any = Rpc.Any> {
  readonly clientRpc: Rpcs;
}
/** Represents client definition payload values. */
export type ClientDefinitionPayload<D extends ClientRpcDefinition> =
  Rpc.PayloadConstructor<D["clientRpc"]>;
/** Represents client definition success values. */
export type ClientDefinitionSuccess<D extends ClientRpcDefinition> =
  Rpc.Success<D["clientRpc"]>;
/** Represents client definition error conditions. */
export type ClientDefinitionError<D extends ClientRpcDefinition> =
  | Rpc.Error<D["clientRpc"]>
  | NotConnectedError
  | RpcTimeoutError;

/** Represents the result of connect. */
export type ConnectResult = ResultOf<typeof agentConnect>;
type ProtocolRpc = Rpc.Any & { readonly _tag: string };
type ConnectTag<Rpcs extends ProtocolRpc> = Extract<
  Rpcs["_tag"],
  typeof agentConnect.name | typeof appConnect.name
>;
/** Represents client connect error conditions. */
export type ClientConnectError<Rpcs extends ProtocolRpc> =
  | ErrorForTag<Rpcs, ConnectTag<Rpcs>>
  | NotConnectedError
  | RpcTimeoutError;

type ClientWebSocket = Effect.Effect.Success<
  ReturnType<typeof Socket.makeWebSocket>
>;

const makeNotConnectedError = (): NotConnectedError =>
  new NotConnectedError({ message: MSG_NOT_CONNECTED });

const decodeServerBaseUrl = Schema.decodeEither(serverBaseUrlSchema);

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
  if (!input.hasCompletedHandshake) {
    return Effect.void;
  }
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

/** Configures client lifecycle. */
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

type AgentCallableRpcs = RpcGroup.Rpcs<typeof agentCallableGroup>;
type AppCallableRpcs = RpcGroup.Rpcs<typeof appCallableGroup>;
type AgentClientDispatch = TypedDispatchMap<AgentCallableRpcs, RpcClientError>;
type AppClientDispatch = TypedDispatchMap<AppCallableRpcs, RpcClientError>;
type SubscriberRegistry = NotificationSubscriberRegistry<
  NotConnectedError,
  AnyNotificationDefinition
>;
type ReverseCallbackDefinition = (typeof appCallbackMethods)[number];

/** Represents reverse callback handlers values. */
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
type TaskNotificationDefinition =
  | typeof messageReceivedNotificationDefinition
  | typeof taskClosedNotificationDefinition
  | typeof taskCreatedNotificationDefinition
  | typeof taskFailedNotificationDefinition
  | typeof conversationCreatedNotificationDefinition
  | typeof conversationParticipantsAddedNotificationDefinition
  | typeof conversationParticipantsRemovedNotificationDefinition;
type DispatchNotificationDefinition =
  | typeof dispatchRelease
  | typeof dispatchLeaseConsumed
  | typeof dispatchLeaseExpired;

type TaskNotificationHandlers =
  NotificationHandlersFor<TaskNotificationDefinition>;
type DispatchNotificationHandlers =
  NotificationHandlersFor<DispatchNotificationDefinition>;

type NotificationHandlerDefinition =
  | TaskNotificationDefinition
  | DispatchNotificationDefinition;
type ExpectTrue<T extends true> = T;
type NotificationCatalogCoversAll = ExpectTrue<
  Exclude<
    AnyNotificationDefinition,
    NotificationHandlerDefinition
  > extends never
    ? true
    : false
>;
type NotificationCatalogHasNoExtra = ExpectTrue<
  Exclude<
    NotificationHandlerDefinition,
    AnyNotificationDefinition
  > extends never
    ? true
    : false
>;
type NotificationCatalogIntegrity = readonly [
  NotificationCatalogCoversAll,
  NotificationCatalogHasNoExtra,
];
type ReverseNotificationHandlers =
  NotificationCatalogIntegrity extends readonly [true, true]
    ? NotificationHandlersFor<AnyNotificationDefinition>
    : never;

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
  (params: NotificationParamsOf<D>): Effect.Effect<void> =>
    registry.dispatch({
      definition,
      method: definition.name,
      params,
    });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const tagOf = (value: unknown): unknown => asObject(value)?._tag;

const taggedErrorFromCause = (frame: Record<string, unknown>): unknown => {
  const error = asObject(frame.error);
  if (error === undefined || error._tag !== "Cause") {
    return undefined;
  }
  const cause = asObject(error.data);
  if (cause === undefined || cause._tag !== "Fail") {
    return undefined;
  }
  const tagged = cause.error;
  return typeof tagOf(tagged) === "string" ? tagged : undefined;
};

const parseJson = (raw: string): unknown =>
  Effect.runSync(
    Effect.try((): unknown => JSON.parse(raw)).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );

const rewriteCauseFrame = (chunk: string): string | undefined => {
  const frame = asObject(parseJson(chunk));
  if (frame === undefined) {
    return undefined;
  }
  const tagged = taggedErrorFromCause(frame);
  if (tagged === undefined) {
    return undefined;
  }
  return JSON.stringify({ ...frame, error: tagged });
};

const flattenReverseErrors =
  (write: WireWrite): WireWrite =>
  (chunk) => {
    if (!chunk.includes("Cause")) {
      return write(chunk);
    }
    const rewritten = rewriteCauseFrame(chunk);
    return write(rewritten ?? chunk);
  };

const buildTaskNotificationHandlers = (
  registry: SubscriberRegistry,
): TaskNotificationHandlers => ({
  [messageReceivedNotificationDefinition.name]: notificationHandler(
    registry,
    messageReceivedNotificationDefinition,
  ),
  [taskClosedNotificationDefinition.name]: notificationHandler(
    registry,
    taskClosedNotificationDefinition,
  ),
  [taskCreatedNotificationDefinition.name]: notificationHandler(
    registry,
    taskCreatedNotificationDefinition,
  ),
  [taskFailedNotificationDefinition.name]: notificationHandler(
    registry,
    taskFailedNotificationDefinition,
  ),
  [conversationCreatedNotificationDefinition.name]: notificationHandler(
    registry,
    conversationCreatedNotificationDefinition,
  ),
  [conversationParticipantsAddedNotificationDefinition.name]:
    notificationHandler(
      registry,
      conversationParticipantsAddedNotificationDefinition,
    ),
  [conversationParticipantsRemovedNotificationDefinition.name]:
    notificationHandler(
      registry,
      conversationParticipantsRemovedNotificationDefinition,
    ),
});

const buildDispatchNotificationHandlers = (
  registry: SubscriberRegistry,
): DispatchNotificationHandlers => ({
  [dispatchRelease.name]: notificationHandler(registry, dispatchRelease),
  [dispatchLeaseConsumed.name]: notificationHandler(
    registry,
    dispatchLeaseConsumed,
  ),
  [dispatchLeaseExpired.name]: notificationHandler(
    registry,
    dispatchLeaseExpired,
  ),
});

const buildNotificationHandlers = (
  registry: SubscriberRegistry,
): ReverseNotificationHandlers => ({
  ...buildTaskNotificationHandlers(registry),
  ...buildDispatchNotificationHandlers(registry),
});

const buildReverseHandlers = (options: {
  readonly registry: SubscriberRegistry;
  readonly callbackHandlers: ReverseCallbackHandlers;
}): ReverseHandlers => ({
  ...options.callbackHandlers,
  ...buildNotificationHandlers(options.registry),
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
    const engineLayer = RpcServer.layer(reverseRpcGroup).pipe(
      Layer.provide(reverseRpcGroup.toLayer(handlers)),
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

/**
 * Provides the open protocol agent client socket runtime value.
 * @param options Options that control the operation.
 * @returns The open protocol agent client socket result.
 */
export const openProtocolAgentClientSocket = (
  options: ClientSocketSessionOptions,
): Effect.Effect<
  ClientConnection<AgentClientDispatch>,
  NotConnectedError,
  Socket.WebSocketConstructor
> =>
  openClientSocketSession({
    ...options,
    group: agentCallableGroup,
  });

/**
 * Provides the open protocol app client socket runtime value.
 * @param options Options that control the operation.
 * @returns The open protocol app client socket result.
 */
export const openProtocolAppClientSocket = (
  options: ClientSocketSessionOptions,
): Effect.Effect<
  ClientConnection<AppClientDispatch>,
  NotConnectedError,
  Socket.WebSocketConstructor
> =>
  openClientSocketSession({
    ...options,
    group: appCallableGroup,
  });

type ConnectWaiter<Rpcs extends ProtocolRpc> = Deferred.Deferred<
  ConnectResult,
  ClientConnectError<Rpcs>
>;

interface ClientGeneration<Rpcs extends ProtocolRpc> {
  readonly token: object;
  readonly owner: Fiber.RuntimeFiber<void>;
  readonly connectWaiters: Array<ConnectWaiter<Rpcs>>;
  readonly disconnectWaiters: Array<Deferred.Deferred<undefined>>;
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
      readonly startReader: Deferred.Deferred<undefined>;
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
      readonly acknowledged: Deferred.Deferred<undefined>;
    }
  | {
      readonly _tag: "OwnerDone";
      readonly token: object;
      readonly openError: NotConnectedError | null;
    }
  | {
      readonly _tag: "Disconnect";
      readonly acknowledged: Deferred.Deferred<undefined>;
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
  private readonly controllerDone: Deferred.Deferred<undefined>;
  private readonly closeCompletion: Deferred.Deferred<undefined>;
  private readonly options: ClientLifecycleOptions<Rpcs, Client>;
  private closed = false;
  private helloResult: ConnectResult | null = null;

  protected constructor(options: ClientLifecycleOptions<Rpcs, Client>) {
    this.options = options;
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
        const controllerDone = yield* Deferred.make<undefined>();
        const closeCompletion = yield* Deferred.make<undefined>();
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
    return this.helloResult;
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
  ): Stream.Stream<R, NotConnectedError>;
  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<NotificationParamsOf<D>, NotConnectedError>;
  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<NotificationParamsOf<D>, NotConnectedError> {
    if (refinement === undefined) {
      return notificationSubscribe(this.subscribers, definition);
    }
    return notificationSubscribe(this.subscribers, definition, refinement);
  }

  /**
   * Acquire a notification subscription before exposing its Stream.
   * The returned Stream is ready to receive immediately, and the caller's
   * Scope owns both unregistration and mailbox termination.
   * @param definition Protocol definition to process.
   * @returns The mailbox result.
   */
  subscribeScoped<D extends AnyNotificationDefinition>(
    definition: D,
  ): Effect.Effect<
    Stream.Stream<NotificationParamsOf<D>, NotConnectedError>,
    never,
    Scope.Scope
  > {
    const subscribers = this.subscribers;
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox.make<
        NotificationParamsOf<D>,
        NotConnectedError
      >(SCOPED_SUBSCRIPTION_CAPACITY);
      const subscription = yield* subscribers.register(definition, {
        onFrame: (params) => mailbox.offer(params).pipe(Effect.asVoid),
        onClose: (cause) => mailbox.fail(cause).pipe(Effect.asVoid),
      });
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
    NotConnectedError
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

  close(): Effect.Effect<void> {
    return Effect.uninterruptible(
      Effect.suspend(() => {
        if (this.closed) {
          return Deferred.await(this.closeCompletion);
        }
        const closeCompletion = this.closeCompletion;
        const controllerDone = this.controllerDone;
        const runtime = this.runtime;
        this.closed = true;
        const hasCompletedHandshake = this.helloResult !== null;
        this.helloResult = null;
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

  disconnect(): Effect.Effect<void> {
    const commands = this.commands;
    const isClosed = (): boolean => this.closed;
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (isClosed()) {
          return;
        }
        const acknowledged = yield* Deferred.make<undefined>();
        const offered = yield* Effect.sync(() => {
          if (isClosed()) {
            return false;
          }
          return commands.unsafeOffer({
            _tag: "Disconnect",
            acknowledged,
          });
        });
        if (!offered) {
          return;
        }
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
      if (this.closed) {
        return Effect.fail(makeNotConnectedError());
      }
      return Ref.get(this.connectionRef).pipe(
        Effect.flatMap((connection) => {
          if (connection === null) {
            return Effect.fail(makeNotConnectedError());
          }
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
    const commands = this.commands;
    const isClosed = (): boolean => this.closed;
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<
          ConnectResult,
          ClientConnectError<Rpcs>
        >();
        const offered = yield* Effect.sync(() => {
          if (isClosed()) {
            return false;
          }
          return commands.unsafeOffer({ _tag: "Connect", reply });
        });
        if (!offered) {
          return yield* Effect.fail(makeNotConnectedError());
        }
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
    const commands = this.commands;
    const handleCommand = this.handleCommand.bind(this);
    return Effect.gen(function* () {
      let state: ClientLifecycleState<Rpcs, Client> = { _tag: "Idle" };
      while (state._tag !== "Stopped") {
        const command = yield* commands.take.pipe(Effect.orDie);
        state = yield* handleCommand(state, command);
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
    return Match.value(command).pipe(
      Match.tag("Connect", ({ reply }) => this.handleConnect(state, reply)),
      Match.tag("SessionOpened", (opened) =>
        this.handleSessionOpened(state, opened),
      ),
      Match.tag("AuthenticationSettled", (settled) =>
        this.handleAuthenticationSettled(state, settled),
      ),
      Match.tag("ReaderExited", (exited) =>
        this.handleReaderExited(state, exited),
      ),
      Match.tag("OwnerDone", ({ token, openError }) =>
        this.handleOwnerDone(state, token, openError),
      ),
      Match.tag("Disconnect", ({ acknowledged }) =>
        this.handleDisconnect(state, acknowledged),
      ),
      Match.tag("Close", ({ hasCompletedHandshake }) =>
        this.handleClose(state, hasCompletedHandshake),
      ),
      Match.exhaustive,
    );
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
      case "Idle": {
        const superviseConnection = this.superviseConnection.bind(this);
        return Effect.gen(function* () {
          const token = {};
          const owner = yield* Effect.forkScoped(superviseConnection(token));
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
      }
      case "Opening":
        return Effect.sync(() => {
          state.generation.connectWaiters.push(reply);
          return state;
        });
      case "Connected":
        if (this.helloResult !== null) {
          return Deferred.succeed(reply, this.helloResult).pipe(
            Effect.as(state),
          );
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
      default:
        return Effect.die(state satisfies never);
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
    const connectionRef = this.connectionRef;
    const authenticate = this.authenticate.bind(this);
    return Effect.gen(function* () {
      yield* Ref.set(connectionRef, command.connection);
      yield* Deferred.succeed(command.startReader, undefined);
      yield* Effect.forkScoped(authenticate(command.token, command.connection));
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
    const connectionRef = this.connectionRef;
    const settleWaiters = this.settleWaiters.bind(this);
    const interruptOwner = this.interruptOwner.bind(this);
    const setHelloOk = (value: ConnectResult | null): void => {
      this.helloResult = value;
    };
    if (Exit.isSuccess(command.exit)) {
      const helloOk = command.exit.value;
      return Effect.gen(function* () {
        setHelloOk(helloOk);
        yield* settleWaiters(state.generation, command.exit);
        return state;
      });
    }
    return Effect.gen(function* () {
      setHelloOk(null);
      yield* Ref.set(connectionRef, null);
      yield* settleWaiters(state.generation, command.exit);
      yield* interruptOwner(state.generation.owner);
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
    const connectionRef = this.connectionRef;
    const failWaiters = this.failWaiters.bind(this);
    const notifyDisconnect = this.notifyDisconnect.bind(this);
    const isClosed = (): boolean => this.closed;
    const clearHelloOk = (): void => {
      this.helloResult = null;
    };
    return Effect.gen(function* () {
      let next = state;
      if (
        state._tag === "Connected" &&
        state.generation.token === command.token
      ) {
        clearHelloOk();
        yield* Ref.set(connectionRef, null);
        yield* failWaiters(state.generation, makeNotConnectedError());
        next = {
          _tag: "Stopping",
          generation: state.generation,
          terminal: isClosed(),
        };
      }
      if (
        !isClosed() &&
        Exit.isFailure(command.exit) &&
        !Cause.isInterruptedOnly(command.exit.cause) &&
        command.close.code !== DEFAULT_GRACEFUL_CLOSE.code
      ) {
        yield* Effect.logWarning("WebSocket error", command.exit.cause);
      }
      yield* notifyDisconnect(command.close);
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
      const connectionRef = this.connectionRef;
      const failWaiters = this.failWaiters.bind(this);
      const clearHelloOk = (): void => {
        this.helloResult = null;
      };
      return Effect.gen(function* () {
        clearHelloOk();
        yield* Ref.set(connectionRef, null);
        yield* failWaiters(state.generation, makeNotConnectedError());
        return { _tag: "Idle" } as const;
      });
    }
    const completeDisconnects = this.completeDisconnects.bind(this);
    return Effect.gen(function* () {
      yield* completeDisconnects(state.generation);
      if (state.terminal) {
        return { _tag: "Stopped" } as const;
      }
      return { _tag: "Idle" } as const;
    });
  }

  private handleDisconnect(
    state: ClientLifecycleState<Rpcs, Client>,
    acknowledged: Deferred.Deferred<undefined>,
  ): Effect.Effect<ClientLifecycleState<Rpcs, Client>, never, Scope.Scope> {
    const failWaiters = this.failWaiters.bind(this);
    const interruptOwner = this.interruptOwner.bind(this);
    const connectionRef = this.connectionRef;
    const clearHelloOk = (): void => {
      this.helloResult = null;
    };
    switch (state._tag) {
      case "Idle":
      case "Stopped":
        return Deferred.succeed(acknowledged, undefined).pipe(Effect.as(state));
      case "Opening":
        return Effect.gen(function* () {
          yield* failWaiters(state.generation, makeNotConnectedError());
          state.generation.disconnectWaiters.push(acknowledged);
          yield* interruptOwner(state.generation.owner);
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
        return Effect.gen(function* () {
          clearHelloOk();
          yield* Ref.set(connectionRef, null);
          yield* failWaiters(state.generation, makeNotConnectedError());
          state.generation.disconnectWaiters.push(acknowledged);
          yield* interruptOwner(state.generation.owner);
          return {
            _tag: "Stopping",
            generation: state.generation,
            terminal: false,
          } satisfies ClientLifecycleState<Rpcs, Client>;
        });
      default:
        return Effect.die(state satisfies never);
    }
  }

  private handleClose(
    state: ClientLifecycleState<Rpcs, Client>,
    hasCompletedHandshake: boolean,
  ): Effect.Effect<ClientLifecycleState<Rpcs, Client>, never, Scope.Scope> {
    const connectionRef = this.connectionRef;
    const subscribers = this.subscribers;
    const failWaiters = this.failWaiters.bind(this);
    const interruptOwner = this.interruptOwner.bind(this);
    const clearHelloOk = (): void => {
      this.helloResult = null;
    };
    return Effect.gen(function* () {
      clearHelloOk();
      yield* Ref.set(connectionRef, null);
      yield* subscribers.closeAll;

      switch (state._tag) {
        case "Idle":
        case "Stopped":
          return { _tag: "Stopped" } as const;
        case "Opening":
          yield* failWaiters(state.generation, makeNotConnectedError());
          yield* interruptOwner(state.generation.owner);
          return {
            _tag: "Stopping",
            generation: state.generation,
            terminal: true,
          } satisfies ClientLifecycleState<Rpcs, Client>;
        case "Connected":
          yield* failWaiters(state.generation, makeNotConnectedError());
          yield* interruptOwner(
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
        default:
          return yield* Effect.die(state satisfies never);
      }
    });
  }

  private superviseConnection(
    token: object,
  ): Effect.Effect<void, never, Socket.WebSocketConstructor> {
    let openError: NotConnectedError | null = null;
    const commands = this.commands;
    const acquireConnection = this.acquireConnection.bind(this);
    const reportReaderExit = this.reportReaderExit.bind(this);
    const session = Effect.scoped(
      acquireConnection().pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              openError = error;
            }),
          onSuccess: (connection) =>
            Effect.gen(function* () {
              const startReader = yield* Deferred.make<undefined>();
              yield* commands.offer({
                _tag: "SessionOpened",
                token,
                connection,
                startReader,
              });
              yield* Deferred.await(startReader);
              yield* connection.reader.pipe(
                Effect.onExit((exit) => reportReaderExit(token, exit)),
                Effect.ignore,
              );
            }),
        }),
      ),
    );
    return session.pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          commands
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
    const commands = this.commands;
    return Effect.gen(function* () {
      const acknowledged = yield* Deferred.make<undefined>();
      yield* commands.offer({
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
    owner: Fiber.RuntimeFiber<void>,
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
    const onDisconnect = this.options.onDisconnect;
    return Effect.gen(function* () {
      try {
        onDisconnect?.(close);
      } catch (err) {
        yield* Effect.logWarning("onDisconnect handler threw", err);
      }
    });
  }
}
/* eslint-enable max-lines -- lifecycle state machine ends here -- Restore strict defaults after the scoped exception. -- Restore strict defaults after the scoped exception. -- Restore strict defaults after the scoped exception. -- Restore strict defaults after the scoped exception. -- Restore strict defaults after the scoped exception. */
