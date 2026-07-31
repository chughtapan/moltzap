# protocol/src

_`packages/protocol/src`_

## Purpose

Protocol package root.

The root surface is intentionally tiny: concrete protocol-owned socket
lifecycle classes only. Domain descriptors, schemas, requirement tags, and
testing helpers live behind focused package subpaths.

## Public surface

### [`AgentClientOptions`](./socket/agent-client.ts#L40)

_Interface_

```ts
export interface AgentClientOptions {
  readonly serverUrl: string;
  readonly agentKey: AgentKey;
  readonly onDisconnect?: (close: CloseInfo) => void;
}
```

Configures agent client.

### [`AppClientOptions`](./socket/app-client.ts#L72)

_Interface_

```ts
export interface AppClientOptions {
  readonly serverUrl: string;
  readonly appKey: AppKey;
  readonly onDisconnect?: (close: CloseInfo) => void;
  readonly handlers: AppCallbackHandlers<AppCallbackContext>;
}
```

Configures app client.

### [`ConnectResult`](./socket/lifecycle.ts#L107)

_TypeAlias_

```ts
export type ConnectResult = ResultOf<typeof agentConnect>;
```

Represents the result of connect.

### [`MoltZapAgentClient`](./socket/agent-client.ts#L47)

_Class_

```ts
export class MoltZapAgentClient extends ProtocolClientLifecycle<
  AgentCallableRpcs,
  AgentClientDispatch
> {
  constructor(options: AgentClientOptions) {
    super({
      serverUrl: options.serverUrl,
      connectTag: agentConnect.name,
      connectPayload: {
        agentKey: options.agentKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      },
      openSession: openProtocolAgentClientSocket,
      callbackHandlers: makeAgentCallbackHandlers,
      onDisconnect: options.onDisconnect,
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

Implements molt zap agent client.

### [`MoltZapAppClient`](./socket/app-client.ts#L80)

_Class_

```ts
export class MoltZapAppClient extends ProtocolClientLifecycle<
  AppCallableRpcs,
  AppClientDispatch
> {
  constructor(options: AppClientOptions) {
    super({
      serverUrl: options.serverUrl,
      connectTag: appConnect.name,
      connectPayload: {
        appKey: options.appKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      },
      openSession: openProtocolAppClientSocket,
      callbackHandlers: () => makeAppCallbackHandlers(options.handlers),
      onDisconnect: options.onDisconnect,
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

Implements molt zap app client.

### [`MoltZapServer`](./socket/server.ts#L298)

_Class_

```ts
export class MoltZapServer<
  AuthRequires,
  ConnectionProvides,
  ConnectionRequires,
  HookRequires = never,
> {
  private readonly options: MoltZapServerOptions<
    AuthRequires,
    ConnectionProvides,
    ConnectionRequires,
    HookRequires
  >;

  constructor(
    options: MoltZapServerOptions<
      AuthRequires,
      ConnectionProvides,
      ConnectionRequires,
      HookRequires
    >,
  ) {
    this.options = options;
  }

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
    const options = this.options;
    const runSocketReader = this.runSocketReader.bind(this);
    return Effect.gen(function* () {
      const accepted = yield* makeAcceptedSocketSession(socket);
      const scope = yield* Effect.scope;
      const originator = yield* buildReverseClient({
        write: accepted.write,
        scope,
      });
      const session = makeMoltZapServerSession(accepted, originator);

      yield* options.onOpen(session);
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
          handlers: options.handlers,
          authLayer: options.authLayer(session.connId),
          connectionLayer: options.connectionLayer(session.connId),
        }),
      );
      const serverSink = yield* Deferred.await(sinkReady);
      const reader = runMuxReader(
        socket,
        { server: serverSink, client: session.originator.sink },
        disconnects,
      );
      yield* runSocketReader(reader, session);
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
    const options = this.options;
    return Effect.raceFirst(
      reader,
      Deferred.await(session.closeRequested),
    ).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          yield* options.onClose(exit, session);
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

Implements molt zap server.

### [`MoltZapServerOptions`](./socket/server.ts#L63)

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

Configures molt zap server.

### [`MoltZapServerSession`](./socket/server.ts#L48)

_Interface_

```ts
export interface MoltZapServerSession {
  readonly connId: ConnectionId;
  readonly write: ServerSocketWrite;
  readonly closeRequested: Deferred.Deferred<undefined>;
  readonly shutdown: Effect.Effect<void>;
  readonly originator: ReverseClient;
}
```

Describes molt zap server session.

### [`RpcCallOptions`](./socket/lifecycle.ts#L86)

_Interface_

```ts
export interface RpcCallOptions {
  readonly timeoutMs?: number;
}
```

Configures rpc call.

## Files

- `agent-client.ts`
- `app-client.ts`
- `lifecycle.ts`
- `server.ts`
