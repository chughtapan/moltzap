# protocol/socket

_`packages/protocol/src/socket`_

## Purpose

Socket lifecycle surface for protocol-owned clients and server.

Owns the concrete MoltZap agent client, app client, server socket lifecycle,
connection identifiers, close-info extraction, and socket-local lifecycle
helpers used by testing and server wiring.

## Public surface

### [`AgentClientOptions`](./agent-client.ts#L41)

_Interface_

```ts
export interface AgentClientOptions {
  readonly serverUrl: string;
  readonly agentKey: AgentKey;
  readonly onDisconnect?: (close: CloseInfo) => void;
  readonly onReconnect?: (helloOk: ConnectResult) => void;
}
```

### [`AppCallbackContext`](./app-client.ts#L35)

_Interface_

```ts
export interface AppCallbackContext {
  readonly requestId: string;
}
```

### [`AppCallbackHandlers`](./app-callbacks.ts#L44)

_TypeAlias_

```ts
export type AppCallbackHandlers<Ctx> = HandlerTable<
  AnyAppCallbackRpcDefinition,
  Ctx
>;
```

Closed handler table for an app moderating one or more tasks. Every
app callback member is required; vacuous-deny moderators still write the
handler explicitly.

### [`AppClientOptions`](./app-client.ts#L72)

_Interface_

```ts
export interface AppClientOptions {
  readonly serverUrl: string;
  readonly appKey: AppKey;
  readonly onDisconnect?: (close: CloseInfo) => void;
  readonly onReconnect?: (helloOk: ConnectResult) => void;
  readonly handlers: AppCallbackHandlers<AppCallbackContext>;
}
```

### [`classifyCloseCause`](./close-info.ts#L41)

_Function_

```ts
export function classifyCloseCause(
  cause: Cause.Cause<Socket.SocketError>,
): CloseKind
```

### [`ClientConnectError`](./lifecycle.ts#L117)

_TypeAlias_

```ts
export type ClientConnectError<Rpcs extends ProtocolRpc> =
```

### [`ClientDefinitionError`](./lifecycle.ts#L106)

_TypeAlias_

```ts
export type ClientDefinitionError<D extends ClientRpcDefinition> =
```

### [`ClientDefinitionPayload`](./lifecycle.ts#L102)

_TypeAlias_

```ts
export type ClientDefinitionPayload<D extends ClientRpcDefinition> =
```

### [`ClientDefinitionSuccess`](./lifecycle.ts#L104)

_TypeAlias_

```ts
export type ClientDefinitionSuccess<D extends ClientRpcDefinition> =
```

### [`ClientLifecycleOptions`](./lifecycle.ts#L212)

_Interface_

```ts
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
```

### [`clientRpc`](./lifecycle.ts#L100)

_Property_

```ts
  readonly clientRpc: Rpcs;
};
export type ClientDefinitionPayload<D extends ClientRpcDefinition> =
```

### [`ClientRpcDefinition`](./lifecycle.ts#L99)

_TypeAlias_

```ts
export type ClientRpcDefinition<Rpcs extends Rpc.Any = Rpc.Any> = {
  readonly clientRpc: Rpcs;
};
```

### [`CloseInfo`](./close-info.ts#L4)

_Interface_

```ts
export interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}
```

### [`CloseKind`](./close-info.ts#L9)

_TypeAlias_

```ts
export type CloseKind = Data.TaggedEnum<{
  Clean: {
    readonly code: number;
    readonly reason: string;
  };
  EndOfStream: {};
  HandshakeFailure: {
    readonly underlying: "Open" | "OpenTimeout";
  };
  TransportFailure: {
    readonly underlying: "Read" | "Write";
  };
  Unknown: {};
}>;
```

### [`connectionId`](./connection.ts#L24)

_Variable_

```ts
export const connectionId = Schema.decodeSync(ConnectionId)
```

### [`ConnectionId`](./connection.ts#L17)

_TypeAlias_

```ts
export type ConnectionId = string & Brand.Brand<"ConnectionId">;
```

Server-internal WebSocket connection identifier. Minted at WS accept
(`crypto.randomUUID()`); not on the wire. Branded so it cannot be
confused with `AgentId`, `AppId`, or other ids in service signatures.

Boundary: a single `as ConnectionId` cast at the WS-accept site is the
only acceptable construction in production code; downstream is brand-
typed end-to-end. Test fixtures use the `connectionId(raw)` constructor
exported from `@moltzap/protocol/testing`.

Schema-level format: branded string (no UUID predicate). The mint site
happens to use UUIDs, but conformance-test fixtures sometimes pass synthetic
strings; the brand boundary is the type system, not a format check.

### [`ConnectionId`](./connection.ts#L17)

_Variable_

```ts
export type ConnectionId = string & Brand.Brand<"ConnectionId">
```

### [`ConnectResult`](./lifecycle.ts#L111)

_TypeAlias_

```ts
export type ConnectResult = ResultOf<typeof AgentConnect>;
```

### [`DEFAULT_ABNORMAL_CLOSE`](./close-info.ts#L30)

_Variable_

```ts
export const DEFAULT_ABNORMAL_CLOSE: CloseInfo =
```

### [`DEFAULT_GRACEFUL_CLOSE`](./close-info.ts#L26)

_Variable_

```ts
export const DEFAULT_GRACEFUL_CLOSE: CloseInfo =
```

### [`DispatchAuthorizeRequest`](./reverse-callbacks.ts#L14)

_TypeAlias_

```ts
export type DispatchAuthorizeRequest = Extract<
  ReverseCallbackRequest,
  { readonly definition: typeof DispatchAuthorize }
>;
```

### [`extractCloseInfo`](./close-info.ts#L79)

_Function_

```ts
export function extractCloseInfo(
  exit: Exit.Exit<void, Socket.SocketError>,
): CloseInfo
```

### [`HandlerSlot`](./app-callbacks.ts#L20)

_Interface_

```ts
export interface HandlerSlot<D extends AppCallbackDescriptor, Ctx> {
  readonly definition: D;
  readonly handle: (
    params: ParamsOf<D>,
    ctx: Ctx,
  ) => Effect.Effect<ResultOf<D>, unknown>;
}
```

Per-definition app-callback handler slot. `Ctx` is the per-frame context the
client hands every handler.

### [`isDispatchAuthorizeRequest`](./reverse-callbacks.ts#L27)

_Function_

```ts
export const isDispatchAuthorizeRequest = (
  request: ReverseCallbackRequest,
): request is DispatchAuthorizeRequest
```

### [`isMessagesAuthorizeRequest`](./reverse-callbacks.ts#L32)

_Function_

```ts
export const isMessagesAuthorizeRequest = (
  request: ReverseCallbackRequest,
): request is MessagesAuthorizeRequest
```

### [`isTaskCreateRequest`](./reverse-callbacks.ts#L37)

_Function_

```ts
export const isTaskCreateRequest = (
  request: ReverseCallbackRequest,
): request is TaskCreateRequest
```

### [`MessagesAuthorizeRequest`](./reverse-callbacks.ts#L18)

_TypeAlias_

```ts
export type MessagesAuthorizeRequest = Extract<
  ReverseCallbackRequest,
  { readonly definition: typeof MessagesAuthorize }
>;
```

### [`MoltZapAgentClient`](./agent-client.ts#L48)

_Class_

```ts
export class MoltZapAgentClient extends ProtocolClientLifecycle<
  AgentCallableRpcs,
  AgentClientDispatch
> {
  constructor(options: AgentClientOptions) {
    super({
      serverUrl: options.serverUrl,
      connectTag: AgentConnect.name,
      connectPayload: {
        agentKey: options.agentKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      },
      openSession: openProtocolAgentClientSocket,
      callbackHandlers: makeAgentCallbackHandlers,
      onDisconnect: options.onDisconnect,
      onReconnect: options.onReconnect,
      failConnectWhenClosed: false,
    });
  }

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
}
```

### [`MoltZapAppClient`](./app-client.ts#L80)

_Class_

```ts
export class MoltZapAppClient extends ProtocolClientLifecycle<
  AppCallableRpcs,
  AppClientDispatch
> {
  constructor(options: AppClientOptions) {
    super({
      serverUrl: options.serverUrl,
      connectTag: AppConnect.name,
      connectPayload: {
        appKey: options.appKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      },
      openSession: openProtocolAppClientSocket,
      callbackHandlers: () => makeAppCallbackHandlers(options.handlers),
      onDisconnect: options.onDisconnect,
      onReconnect: options.onReconnect,
      failConnectWhenClosed: true,
    });
  }

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
}
```

### [`MoltZapServer`](./server.ts#L300)

_Class_

```ts
export class MoltZapServer<
  AuthRequires,
  ConnectionProvides,
  ConnectionRequires,
  HookRequires = never,
> {
  constructor(
    private readonly options: MoltZapServerOptions<
      AuthRequires,
      ConnectionProvides,
      ConnectionRequires,
      HookRequires
    >,
  ) {}

  handleSocket(
    socket: Socket.Socket,
  ): Effect.Effect<
    void,
    Socket.SocketError,
    ServerSocketRequirements<AuthRequires, ConnectionRequires, HookRequires>
  > {
    return Effect.scoped(this.openSocketSession(socket));
  }

  private openSocketSession(
    socket: Socket.Socket,
  ): Effect.Effect<
    void,
    Socket.SocketError,
    ScopedServerSocketRequirements<
      AuthRequires,
      ConnectionRequires,
      HookRequires
    >
  > {
    return Effect.gen(this, function* () {
      const accepted = yield* makeAcceptedSocketSession(socket);
      const scope = yield* Effect.scope;
      const originator = yield* buildReverseClient({
        write: accepted.write,
        scope,
      });
      const session = makeMoltZapServerSession(accepted, originator);

      yield* this.options.onOpen(session);
      yield* Effect.logInfo("WebSocket connected").pipe(
        Effect.annotateLogs({ connId: session.connId }),
      );

      const disconnects = yield* Mailbox.make<number>();
      const sinkReady = yield* Deferred.make<ChannelSink>();
      yield* Layer.build(
        makeSocketRpcLayer({
          write: session.write,
          disconnects,
          sinkReady,
          handlers: this.options.handlers,
          authLayer: this.options.authLayer(session.connId),
          connectionLayer: this.options.connectionLayer(session.connId),
        }),
      );
      const serverSink = yield* Deferred.await(sinkReady);
      const reader = runMuxReader(
        socket,
        { server: serverSink, client: session.originator.sink },
        disconnects,
        session.write,
      );
      yield* this.runSocketReader(reader, session);
    }).pipe(Effect.withSpan("MoltZapServer.openSocketSession"));
  }

  private runSocketReader(
    reader: Effect.Effect<
      void,
      Socket.SocketError,
      ServerSocketRequirements<AuthRequires, ConnectionRequires, HookRequires>
    >,
    session: MoltZapServerSession,
  ): Effect.Effect<
    void,
    Socket.SocketError,
    ServerSocketRequirements<AuthRequires, ConnectionRequires, HookRequires>
  > {
    return Effect.raceFirst(
      reader,
      Deferred.await(session.closeRequested),
    ).pipe(
      Effect.onExit((exit) =>
        Effect.gen(this, function* () {
          yield* this.options.onClose(exit, session);
          if (Exit.isFailure(exit)) {
            yield* Effect.logWarning("WebSocket error").pipe(
              Effect.annotateLogs({
                connId: session.connId,
                cause: Cause.pretty(exit.cause),
              }),
            );
          }
          yield* Effect.logInfo("WebSocket disconnected").pipe(
            Effect.annotateLogs({ connId: session.connId }),
          );
        }),
      ),
    );
  }
}
```

### [`MoltZapServerOptions`](./server.ts#L68)

_Interface_

```ts
export interface MoltZapServerOptions<
  AuthRequires,
  ConnectionProvides,
  ConnectionRequires,
  HookRequires = never,
> {
  readonly handlers: ServerHandlers;
  readonly authLayer: (
    connId: ConnectionId,
  ) => Layer.Layer<ServerRequirementMiddleware, never, AuthRequires>;
  readonly connectionLayer: (
    connId: ConnectionId,
  ) => Layer.Layer<ConnectionProvides, never, ConnectionRequires>;
  readonly onOpen: (
    session: MoltZapServerSession,
  ) => Effect.Effect<void, never, HookRequires>;
  readonly onClose: (
    exit: Exit.Exit<void, Socket.SocketError>,
    session: MoltZapServerSession,
  ) => Effect.Effect<void, never, HookRequires>;
}
```

### [`MoltZapServerSession`](./server.ts#L54)

_Interface_

```ts
export interface MoltZapServerSession {
  readonly connId: ConnectionId;
  readonly write: ServerSocketWrite;
  readonly closeRequested: Deferred.Deferred<void>;
  readonly shutdown: Effect.Effect<void>;
  readonly originator: ReverseClient;
}
```

### [`newConnectionId`](./connection.ts#L26)

_Function_

```ts
export const newConnectionId = (): ConnectionId
```

### [`openProtocolAgentClientSocket`](./lifecycle.ts#L561)

_Function_

```ts
export const openProtocolAgentClientSocket = (
  options: ClientSocketSessionOptions<AgentCallableRpcs>,
): Effect.Effect<
  ClientConnection<AgentCallableRpcs, AgentClientDispatch>,
  NotConnectedError,
  Socket.WebSocketConstructor
>
```

### [`openProtocolAppClientSocket`](./lifecycle.ts#L573)

_Function_

```ts
export const openProtocolAppClientSocket = (
  options: ClientSocketSessionOptions<AppCallableRpcs>,
): Effect.Effect<
  ClientConnection<AppCallableRpcs, AppClientDispatch>,
  NotConnectedError,
  Socket.WebSocketConstructor
>
```

### [`ProtocolClientLifecycle`](./lifecycle.ts#L642)

_Class_

```ts
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
```

### [`ReverseCallbackError`](./server.ts#L156)

_TypeAlias_

```ts
export type ReverseCallbackError<D extends AnyAppCallbackRpcDefinition> =
```

### [`ReverseCallbackHandlers`](./lifecycle.ts#L259)

_TypeAlias_

```ts
export type ReverseCallbackHandlers = {
  readonly [D in ReverseCallbackDefinition as D["name"]]: Rpc.ToHandlerFn<
    D["clientRpc"],
    never
  >;
};
```

### [`ReverseCallbackPayload`](./server.ts#L152)

_TypeAlias_

```ts
export type ReverseCallbackPayload<D extends AnyAppCallbackRpcDefinition> =
```

### [`ReverseCallbackRequest`](./server.ts#L158)

_TypeAlias_

```ts
export type ReverseCallbackRequest =
  | {
      readonly definition: typeof DispatchAuthorize;
      readonly params: ReverseCallbackPayload<typeof DispatchAuthorize>;
    }
```

### [`ReverseCallbackSuccess`](./server.ts#L154)

_TypeAlias_

```ts
export type ReverseCallbackSuccess<D extends AnyAppCallbackRpcDefinition> =
```

### [`ReverseCallbackTag`](./server.ts#L148)

_TypeAlias_

```ts
export type ReverseCallbackTag<D extends AnyAppCallbackRpcDefinition> = Extract<
  D["clientRpc"]["_tag"],
  ReverseTag
>;
```

### [`ReverseCallError`](./server.ts#L144)

_TypeAlias_

```ts
export type ReverseCallError = NotConnectedError | RpcTimeoutError;

type ReverseRpcs = RpcGroup.Rpcs<typeof ReverseRpcGroup>;
```

### [`ReverseClient`](./server.ts#L204)

_Interface_

```ts
export interface ReverseClient {
  readonly call: <Tag extends ReverseTag>(
    tag: Tag,
    payload: PayloadForTag<ReverseRpcs, Tag>,
  ) => Effect.Effect<
    SuccessForTag<ReverseRpcs, Tag>,
    ErrorForTag<ReverseRpcs, Tag> | ReverseCallError
  >;
  readonly callback: (
    request: ReverseCallbackRequest,
  ) => Effect.Effect<
    ReverseCallbackRequestSuccess,
    ReverseCallbackRequestError | ReverseCallError
  >;
  readonly notify: <D extends AnyNotificationDefinition>(
    definition: D,
    params: NotificationPayloadOf<D>,
  ) => Effect.Effect<void, ReverseCallError>;
  readonly sink: ChannelSink;
}
```

### [`RPC_TIMEOUT_MS`](./lifecycle.ts#L85)

_Variable_

```ts
export const RPC_TIMEOUT_MS = 30_000
```

### [`RpcCallOptions`](./lifecycle.ts#L95)

_Interface_

```ts
export interface RpcCallOptions {
  readonly timeoutMs?: number;
}
```

### [`ServerSocketWrite`](./server.ts#L50)

_TypeAlias_

```ts
export type ServerSocketWrite = (
  raw: string,
) => Effect.Effect<void, Socket.SocketError>;
```

### [`TaskCreateRequest`](./reverse-callbacks.ts#L22)

_TypeAlias_

```ts
export type TaskCreateRequest = Extract<
  ReverseCallbackRequest,
  { readonly definition: typeof TaskCreate }
>;
```

## Files

- `agent-client.ts`
- `app-callbacks.ts`
- `app-client.ts`
- `close-info.ts`
- `connection.ts`
- `lifecycle.ts`
- `reverse-callbacks.ts`
- `server.ts`
