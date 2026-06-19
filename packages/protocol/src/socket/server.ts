import * as Socket from "@effect/platform/Socket";
import { RpcClient, RpcGroup, RpcServer, type Rpc } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import { Cause, Deferred, Effect, Exit, Layer, Mailbox, Scope } from "effect";
import { ConnectionId, newConnectionId } from "./connection.js";
import {
  isDispatchAuthorizeRequest,
  isMessagesAuthorizeRequest,
  isTaskCreateRequest,
} from "./reverse-callbacks.js";
import {
  ReverseRpcGroup,
  ServerInboundGroup,
  type AnyAppCallbackRpcDefinition,
  type AnyNotificationDefinition,
  type ServerHandlers,
} from "#socket/catalog";
import { MessagesAuthorize } from "#message";
import { TaskCreate } from "#task";
import { DispatchAuthorize } from "#message/dispatch";
import {
  makeClientChannelProtocol,
  runMuxReader,
  type ChannelSink,
  type WireWrite,
} from "#transport";
import { makeServerProtocolLayer } from "./internal/protocol-layer.js";
import {
  makeTypedTransportCall,
  type ErrorForTag,
  type PayloadForTag,
  type SuccessForTag,
  type TypedDispatchMap,
} from "#transport";
import { NotConnectedError, RpcTimeoutError } from "#transport";
import type {
  AgentPrincipal,
  AppPrincipal,
  AuthenticatedPrincipal,
} from "#identity/principals";
import type { ActiveAgent } from "#identity/requirements";
import type { NotificationPayloadOf } from "#transport";
import type {
  ConversationInTask,
  ConversationSendAccess,
} from "#conversation/requirements";
import type { ContactPolicyAllowsReach } from "#identity/contacts/requirements";
import type { TaskReadAccess } from "#task/requirements";

export type ServerSocketWrite = (
  raw: string,
) => Effect.Effect<void, Socket.SocketError>;

export interface MoltZapServerSession {
  readonly connId: ConnectionId;
  readonly write: ServerSocketWrite;
  readonly closeRequested: Deferred.Deferred<void>;
  readonly shutdown: Effect.Effect<void>;
  readonly originator: ReverseClient;
}

interface ServerSocketLayerState {
  readonly write: WireWrite;
  readonly disconnects: Mailbox.Mailbox<number>;
  readonly sinkReady: Deferred.Deferred<ChannelSink>;
}

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

type ServerRequirementMiddleware =
  | AgentPrincipal
  | AppPrincipal
  | AuthenticatedPrincipal
  | ActiveAgent
  | ConversationInTask
  | ConversationSendAccess
  | TaskReadAccess
  | ContactPolicyAllowsReach;

const serverRpcLayer = RpcServer.layer(ServerInboundGroup);

interface SocketRpcLayerOptions<
  AuthRequires,
  ConnectionProvides,
  ConnectionRequires,
> extends ServerSocketLayerState {
  readonly handlers: ServerHandlers;
  readonly authLayer: Layer.Layer<
    ServerRequirementMiddleware,
    never,
    AuthRequires
  >;
  readonly connectionLayer: Layer.Layer<
    ConnectionProvides,
    never,
    ConnectionRequires
  >;
}

const makeSocketRpcLayer = <
  AuthRequires,
  ConnectionProvides,
  ConnectionRequires,
>(
  options: SocketRpcLayerOptions<
    AuthRequires,
    ConnectionProvides,
    ConnectionRequires
  >,
): Layer.Layer<never, never, AuthRequires | ConnectionRequires> =>
  serverRpcLayer.pipe(
    Layer.provide(ServerInboundGroup.toLayer(options.handlers)),
    Layer.provide(options.authLayer),
    Layer.provide(options.connectionLayer),
    Layer.provide(
      makeServerProtocolLayer({
        write: options.write,
        disconnects: options.disconnects,
        sinkReady: options.sinkReady,
      }),
    ),
  );

export type ReverseCallError = NotConnectedError | RpcTimeoutError;

type ReverseRpcs = RpcGroup.Rpcs<typeof ReverseRpcGroup>;
type ReverseTag = ReverseRpcs["_tag"];
export type ReverseCallbackTag<D extends AnyAppCallbackRpcDefinition> = Extract<
  D["clientRpc"]["_tag"],
  ReverseTag
>;
export type ReverseCallbackPayload<D extends AnyAppCallbackRpcDefinition> =
  Rpc.PayloadConstructor<D["clientRpc"]>;
export type ReverseCallbackSuccess<D extends AnyAppCallbackRpcDefinition> =
  Rpc.Success<D["clientRpc"]>;
export type ReverseCallbackError<D extends AnyAppCallbackRpcDefinition> =
  Rpc.Error<D["clientRpc"]>;
export type ReverseCallbackRequest =
  | {
      readonly definition: typeof DispatchAuthorize;
      readonly params: ReverseCallbackPayload<typeof DispatchAuthorize>;
    }
  | {
      readonly definition: typeof MessagesAuthorize;
      readonly params: ReverseCallbackPayload<typeof MessagesAuthorize>;
    }
  | {
      readonly definition: typeof TaskCreate;
      readonly params: ReverseCallbackPayload<typeof TaskCreate>;
    };
type ReverseCallbackRequestDefinition = ReverseCallbackRequest["definition"];
type ReverseCallbackRequestSuccess =
  ReverseCallbackSuccess<ReverseCallbackRequestDefinition>;
type ReverseCallbackRequestError =
  ReverseCallbackError<ReverseCallbackRequestDefinition>;
type ReverseTransportCall = <Tag extends ReverseTag>(
  tag: Tag,
  payload: PayloadForTag<ReverseRpcs, Tag>,
) => Effect.Effect<
  SuccessForTag<ReverseRpcs, Tag>,
  ErrorForTag<ReverseRpcs, Tag> | ReverseCallError
>;

const makeReverseNotify =
  (call: ReverseTransportCall): ReverseClient["notify"] =>
  (definition, params) =>
    call(definition.notificationRpc._tag, params).pipe(Effect.asVoid);

const makeReverseCallback =
  (call: ReverseTransportCall): ReverseClient["callback"] =>
  (request) => {
    if (isDispatchAuthorizeRequest(request)) {
      return call(DispatchAuthorize.clientRpc._tag, request.params);
    }
    if (isMessagesAuthorizeRequest(request)) {
      return call(MessagesAuthorize.clientRpc._tag, request.params);
    }
    if (isTaskCreateRequest(request)) {
      return call(TaskCreate.clientRpc._tag, request.params);
    }
    return Effect.dieMessage("unknown reverse callback request");
  };

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

interface AcceptedSocketSession {
  readonly connId: ConnectionId;
  readonly write: ServerSocketWrite;
  readonly closeRequested: Deferred.Deferred<void>;
}

const makeMoltZapServerSession = (
  accepted: AcceptedSocketSession,
  originator: ReverseClient,
): MoltZapServerSession => ({
  ...accepted,
  shutdown: Deferred.succeed(accepted.closeRequested, undefined).pipe(
    Effect.asVoid,
  ),
  originator,
});

type ServerSocketRequirements<AuthRequires, ConnectionRequires, HookRequires> =
  | AuthRequires
  | ConnectionRequires
  | HookRequires;
type ScopedServerSocketRequirements<
  AuthRequires,
  ConnectionRequires,
  HookRequires,
> =
  | ServerSocketRequirements<AuthRequires, ConnectionRequires, HookRequires>
  | Scope.Scope;

const makeReverseClientProtocolLayer = (options: {
  readonly write: WireWrite;
  readonly sinkReady: Deferred.Deferred<ChannelSink>;
}): Layer.Layer<RpcClient.Protocol> => {
  const builder = makeClientChannelProtocol({
    write: options.write,
  });
  return Layer.scoped(
    RpcClient.Protocol,
    RpcClient.Protocol.make((write) =>
      builder(write).pipe(
        Effect.tap((built) => Deferred.succeed(options.sinkReady, built.sink)),
        Effect.map((built) => built.impl),
      ),
    ),
  );
};

const buildReverseClient = (options: {
  readonly write: WireWrite;
  readonly scope: Scope.Scope;
}): Effect.Effect<ReverseClient> =>
  Effect.gen(function* () {
    const sinkReady = yield* Deferred.make<ChannelSink>();
    const protocolLayer = makeReverseClientProtocolLayer({
      write: options.write,
      sinkReady,
    });
    const client: TypedDispatchMap<ReverseRpcs, RpcClientError> =
      yield* RpcClient.make(ReverseRpcGroup).pipe(
        Effect.provide(protocolLayer),
        Scope.extend(options.scope),
      );
    const sink = yield* Deferred.await(sinkReady);
    const call = makeTypedTransportCall(
      client,
      () => new NotConnectedError({ message: "reverse socket closed" }),
    );
    return {
      call,
      callback: makeReverseCallback(call),
      notify: makeReverseNotify(call),
      sink,
    };
  }).pipe(Effect.withSpan("buildReverseClient"));

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

function makeAcceptedSocketSession(
  socket: Socket.Socket,
): Effect.Effect<AcceptedSocketSession, never, Scope.Scope> {
  return Effect.gen(function* () {
    const connId = newConnectionId();
    const writer = yield* socket.writer;
    const closeRequested = yield* Deferred.make<void>();
    const write: ServerSocketWrite = (raw) => writer(raw);
    return { connId, write, closeRequested };
  }).pipe(Effect.withSpan("MoltZapServer.makeAcceptedSocketSession"));
}
