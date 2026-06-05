# protocol/src

_`packages/protocol/src`_

## Purpose

Protocol package root.

Transitional compatibility surface while the protocol package is rebalanced.
The final root target is the runtime lifecycle surface; descriptor and schema
exports are already available on focused subpaths.

## Public surface

### [`AgentCallableGroup`](./rpc-method-groups.ts#L83)

_Variable_

```ts
export const AgentCallableGroup = makeClientRpcGroup(agentCallableMethods)
```

### [`agentCallableMethods`](./rpc-method-groups.ts#L39)

_Variable_

```ts
export const agentCallableMethods = [
  ...identityRpcMethods,
  ...agentCallableNetworkRpcMethods,
  ...agentCallableTaskRpcMethods,
  ...agentCallableAppRpcMethods,
] as const
```

### [`AgentClientOptions`](./agent-client.ts#L38)

_Interface_

```ts
export interface AgentClientOptions {
  readonly serverUrl: string;
  readonly agentKey: AgentKey;
  readonly onDisconnect?: (close: CloseInfo) => void;
  readonly onReconnect?: (helloOk: ConnectResult) => void;
}
```

### [`AgentKey`](./credentials.ts#L26)

_TypeAlias_

```ts
export const AgentKey = Schema.Redacted(AgentKeyValue);
```

### [`AgentKey`](./credentials.ts#L26)

_Variable_

```ts
export const AgentKey = Schema.Redacted(AgentKeyValue)
```

### [`AnyAgentCallableRpcDefinition`](./rpc-method-groups.ts#L67)

_TypeAlias_

```ts
export type AnyAgentCallableRpcDefinition =
  (typeof agentCallableMethods)[number];
```

### [`AnyAppCallableRpcDefinition`](./rpc-method-groups.ts#L69)

_TypeAlias_

```ts
export type AnyAppCallableRpcDefinition = (typeof appCallableMethods)[number];
```

### [`AnyAppCallbackRpcDefinition`](./rpc-method-groups.ts#L71)

_TypeAlias_

```ts
export type AnyAppCallbackRpcDefinition = (typeof appCallbackMethods)[number];
```

### [`AnyNotificationDefinition`](./rpc-method-groups.ts#L73)

_TypeAlias_

```ts
export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];
```

### [`AnyServerRpcDefinition`](./rpc-method-groups.ts#L66)

_TypeAlias_

```ts
export type AnyServerRpcDefinition = (typeof serverInboundMethods)[number];
```

### [`AppCallableGroup`](./rpc-method-groups.ts#L85)

_Variable_

```ts
export const AppCallableGroup = makeClientRpcGroup(appCallableMethods)
```

### [`appCallableMethods`](./rpc-method-groups.ts#L46)

_Variable_

```ts
export const appCallableMethods = [
  ...appCallableNetworkRpcMethods,
  ...appOnlyCallableMethods,
] as const
```

### [`AppCallbackContext`](./app-client.ts#L33)

_Interface_

```ts
export interface AppCallbackContext {
  readonly requestId: string;
}
```

### [`AppClientOptions`](./app-client.ts#L70)

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

### [`AppKey`](./credentials.ts#L29)

_TypeAlias_

```ts
export const AppKey = Schema.Redacted(AppKeyValue);
```

### [`AppKey`](./credentials.ts#L29)

_Variable_

```ts
export const AppKey = Schema.Redacted(AppKeyValue)
```

### [`CapabilityRequirement`](./requirements.ts#L34)

_TypeAlias_

```ts
export type CapabilityRequirement =
  | typeof ConversationInTask
  | typeof ConversationSendAccess
  | typeof TaskReadAccess
  | typeof ContactPolicyAllowsReach;

export type Requirement =
  | PrincipalRequirement
  | typeof AgentClaimed
  | CapabilityRequirement;

/**
 * The middleware stack for a `requires` tuple, de-duplicated by middleware tag.
 * The descriptor order is logical run order. `@effect/rpc` runs the last
 * attached middleware first, so the engine attaches the reverse order.
 */
export const middlewaresForRequirements = (
  requires: ReadonlyArray<Requirement>,
): ReadonlyArray<Requirement> => {
  const stack: Requirement[] = [];
  const seen = new Set<Requirement>();
  for (const requirement of requires) {
    if (!seen.has(requirement)) {
      seen.add(requirement);
      stack.push(requirement);
    }
  }
  return stack.reverse();
};
```

### [`classifyCloseCause`](./close-info.ts#L39)

_Function_

```ts
export function classifyCloseCause(
  cause: Cause.Cause<Socket.SocketError>,
): CloseKind
```

### [`ClientConnectError`](./client-lifecycle.ts#L112)

_TypeAlias_

```ts
export type ClientConnectError<Rpcs extends ProtocolRpc> =
```

### [`ClientDefinitionError`](./client-lifecycle.ts#L101)

_TypeAlias_

```ts
export type ClientDefinitionError<D extends ClientRpcDefinition> =
```

### [`ClientDefinitionPayload`](./client-lifecycle.ts#L97)

_TypeAlias_

```ts
export type ClientDefinitionPayload<D extends ClientRpcDefinition> =
```

### [`ClientDefinitionSuccess`](./client-lifecycle.ts#L99)

_TypeAlias_

```ts
export type ClientDefinitionSuccess<D extends ClientRpcDefinition> =
```

### [`ClientLifecycleOptions`](./client-lifecycle.ts#L207)

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

### [`clientRpc`](./client-lifecycle.ts#L95)

_Property_

```ts
  readonly clientRpc: Rpcs;
};
export type ClientDefinitionPayload<D extends ClientRpcDefinition> =
```

### [`ClientRpcDefinition`](./client-lifecycle.ts#L94)

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

### [`ConnectResult`](./client-lifecycle.ts#L106)

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

### [`extractCloseInfo`](./close-info.ts#L77)

_Function_

```ts
export function extractCloseInfo(
  exit: Exit.Exit<void, Socket.SocketError>,
): CloseInfo
```

### [`InviteCode`](./credentials.ts#L38)

_TypeAlias_

```ts
export const InviteCode = Schema.Redacted(InviteCodeValue);
```

### [`InviteCode`](./credentials.ts#L38)

_Variable_

```ts
export const InviteCode = Schema.Redacted(InviteCodeValue)
```

### [`makeServerProtocolLayer`](./server-lifecycle.ts#L109)

_Function_

```ts
export const makeServerProtocolLayer = (options: {
  readonly write: WireWrite;
  readonly disconnects: Mailbox.Mailbox<number>;
  readonly sinkReady: Deferred.Deferred<ChannelSink>;
}): Layer.Layer<RpcServer.Protocol>
```

### [`middlewaresForRequirements`](./requirements.ts#L50)

_Function_

```ts
export const middlewaresForRequirements = (
  requires: ReadonlyArray<Requirement>,
): ReadonlyArray<Requirement>
```

The middleware stack for a `requires` tuple, de-duplicated by middleware tag.
The descriptor order is logical run order. `@effect/rpc` runs the last
attached middleware first, so the engine attaches the reverse order.

### [`MoltZapAgentClient`](./agent-client.ts#L45)

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

### [`MoltZapAppClient`](./app-client.ts#L78)

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

### [`MoltZapServer`](./server-lifecycle.ts#L355)

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

### [`MoltZapServerOptions`](./server-lifecycle.ts#L64)

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

### [`MoltZapServerSession`](./server-lifecycle.ts#L50)

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

### [`MwStackFor`](./requirements.ts#L64)

_TypeAlias_

```ts
export type MwStackFor<Requires extends ReadonlyArray<unknown>> = Extract<
  Requires[number],
  Requirement
>;
```

### [`notificationDefinitions`](./rpc-method-groups.ts#L59)

_Variable_

```ts
export const notificationDefinitions = [
  ...networkNotifications,
  ...identityNotifications,
  ...taskNotifications,
  ...appNotifications,
] as const
```

### [`NotificationRpcGroup`](./rpc-method-groups.ts#L128)

_Variable_

```ts
export const NotificationRpcGroup = makeNotificationRpcGroup(
  notificationDefinitions,
)
```

Server→client reverse notification group. The server fires each notification
as a fire-and-forget `void`-result RPC on a target connection's reverse
channel; the client serves it via `RpcServer&lt;NotificationRpcGroup>`, routing
each payload into the `SubscriberRegistry`. Reuses the same s2c reverse-RPC
machinery as the moderator callbacks folded into ReverseRpcGroup.

### [`openProtocolAgentClientSocket`](./client-lifecycle.ts#L564)

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

### [`openProtocolAppClientSocket`](./client-lifecycle.ts#L576)

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

### [`Principal`](./requirements.ts#L30)

_TypeAlias_

```ts
export type Principal =
  | { readonly _tag: "AgentContext"; readonly agentId: AgentId }
```

The authenticated principal of the in-flight request. The server's
`AgentContext` / `AppContext` structurally inhabit this union, so the server
can return the live narrowed arm directly from the principal gate.

### [`principalRequirementOf`](./requirements.ts#L69)

_Function_

```ts
export const principalRequirementOf = (
  requires: ReadonlyArray<Requirement>,
): PrincipalRequirement | undefined
```

### [`PrincipalRequirementOf`](./requirements.ts#L80)

_TypeAlias_

```ts
export type PrincipalRequirementOf<
  Requires extends ReadonlyArray<Requirement>,
> = Requires extends readonly [infer Head, ...ReadonlyArray<unknown>]
```

### [`ProtocolClientLifecycle`](./client-lifecycle.ts#L645)

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

### [`RegistrationSecret`](./credentials.ts#L58)

_TypeAlias_

```ts
export const RegistrationSecret = Schema.Redacted(RegistrationSecretValue);
```

### [`RegistrationSecret`](./credentials.ts#L58)

_Variable_

```ts
export const RegistrationSecret = Schema.Redacted(RegistrationSecretValue)
```

### [`Requirement`](./requirements.ts#L40)

_TypeAlias_

```ts
export type Requirement =
  | PrincipalRequirement
  | typeof AgentClaimed
  | CapabilityRequirement;

/**
 * The middleware stack for a `requires` tuple, de-duplicated by middleware tag.
 * The descriptor order is logical run order. `@effect/rpc` runs the last
 * attached middleware first, so the engine attaches the reverse order.
 */
export const middlewaresForRequirements = (
  requires: ReadonlyArray<Requirement>,
): ReadonlyArray<Requirement> => {
  const stack: Requirement[] = [];
  const seen = new Set<Requirement>();
  for (const requirement of requires) {
    if (!seen.has(requirement)) {
      seen.add(requirement);
      stack.push(requirement);
    }
  }
  return stack.reverse();
};
```

### [`requiresClaimed`](./requirements.ts#L88)

_Function_

```ts
export const requiresClaimed = (
  requires: ReadonlyArray<Requirement>,
): boolean
```

### [`ReverseCallbackError`](./server-lifecycle.ts#L185)

_TypeAlias_

```ts
export type ReverseCallbackError<D extends AnyAppCallbackRpcDefinition> =
```

### [`ReverseCallbackHandlers`](./client-lifecycle.ts#L254)

_TypeAlias_

```ts
export type ReverseCallbackHandlers = {
  readonly [D in ReverseCallbackDefinition as D["name"]]: Rpc.ToHandlerFn<
    D["clientRpc"],
    never
  >;
};
```

### [`ReverseCallbackPayload`](./server-lifecycle.ts#L181)

_TypeAlias_

```ts
export type ReverseCallbackPayload<D extends AnyAppCallbackRpcDefinition> =
```

### [`ReverseCallbackRequest`](./server-lifecycle.ts#L187)

_TypeAlias_

```ts
export type ReverseCallbackRequest =
  | {
      readonly definition: typeof DispatchAuthorize;
      readonly params: ReverseCallbackPayload<typeof DispatchAuthorize>;
    }
```

### [`ReverseCallbackSuccess`](./server-lifecycle.ts#L183)

_TypeAlias_

```ts
export type ReverseCallbackSuccess<D extends AnyAppCallbackRpcDefinition> =
```

### [`ReverseCallbackTag`](./server-lifecycle.ts#L177)

_TypeAlias_

```ts
export type ReverseCallbackTag<D extends AnyAppCallbackRpcDefinition> = Extract<
  D["clientRpc"]["_tag"],
  ReverseTag
>;
```

### [`ReverseCallError`](./server-lifecycle.ts#L173)

_TypeAlias_

```ts
export type ReverseCallError = NotConnectedError | RpcTimeoutError;

type ReverseRpcs = RpcGroup.Rpcs<typeof ReverseRpcGroup>;
```

### [`ReverseClient`](./server-lifecycle.ts#L259)

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

### [`ReverseRpcGroup`](./rpc-method-groups.ts#L143)

_Variable_

```ts
export const ReverseRpcGroup = makeReverseRpcGroup(
  appCallbackMethods,
  notificationDefinitions,
)
```

The full server→client reverse group: the moderator callbacks
(`appCallbackMethods`) ∪ the notifications (NotificationRpcGroup),
built as ONE `RpcGroup` over the combined member tuple (not `merge`). The
server holds one `RpcClient&lt;ReverseRpcGroup>` per connection (fires callbacks
awaiting a verdict, fires notifications fork-and-forget); the agent + app
clients stand one `RpcServer&lt;ReverseRpcGroup>` on the s2c sink. An agent client
only ever receives notifications (its handlers for the three callback methods
are never invoked — an agent is not a moderator), but it serves the whole
group so the s2c engine binds one handler map.

### [`RPC_TIMEOUT_MS`](./client-lifecycle.ts#L80)

_Variable_

```ts
export const RPC_TIMEOUT_MS = 30_000
```

### [`RpcCallOptions`](./client-lifecycle.ts#L90)

_Interface_

```ts
export interface RpcCallOptions {
  readonly timeoutMs?: number;
}
```

### [`ServerEncryptionMasterSecret`](./credentials.ts#L61)

_TypeAlias_

```ts
export const ServerEncryptionMasterSecret = Schema.Redacted(
  ServerEncryptionMasterSecretValue,
);
```

### [`ServerEncryptionMasterSecret`](./credentials.ts#L61)

_Variable_

```ts
export const ServerEncryptionMasterSecret = Schema.Redacted(
  ServerEncryptionMasterSecretValue,
)
```

### [`serverInboundMethods`](./rpc-method-groups.ts#L51)

_Variable_

```ts
export const serverInboundMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...agentCallableTaskRpcMethods,
  ...appOnlyCallableMethods,
  ...agentCallableAppRpcMethods,
] as const
```

### [`ServerSocketWrite`](./server-lifecycle.ts#L46)

_TypeAlias_

```ts
export type ServerSocketWrite = (
  raw: string,
) => Effect.Effect<void, Socket.SocketError>;
```

## Files

- `agent-client.ts`
- `app-client.ts`
- `client-lifecycle.ts`
- `close-info.ts`
- `credentials.ts`
- `requirements.ts`
- `rpc-method-groups.ts`
- `server-lifecycle.ts`
