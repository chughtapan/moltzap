/**
 * @file Public barrel for JSON-RPC transport descriptors and runtime helpers.
 */
// Wire (frame types only — request/response/notification frame builders
// are per-def `encode*` methods on RpcDefinition / NotificationDefinition.
// `encodeErrorResponse` is the single method-agnostic wire encoder.)
export { encodeErrorResponse, jsonRpcMethod } from "./wire.js";
export type {
  JsonRpcId,
  JsonRpcMethod,
  RequestFrame,
  ResponseFrame,
  NotificationFrame,
} from "./wire.js";

// Wire frame schemas (TypeBox) — exported so testing/conformance can
// validate frames against the canonical shape via @moltzap/protocol/transport
// rather than reaching into wire.js by relative path.
export {
  responseFrameSchema,
  responseFrameSchema as ResponseFrameSchema,
  notificationFrameSchema,
  notificationFrameSchema as NotificationFrameSchema,
} from "./wire.js";

// RPC + notification descriptor types. Decoders are protocol-internal;
// consumers go through `decodeServerInbound` (rpc-registry.ts) or per-def
// `validateParams`.
export type {
  RpcDefinition,
  NotificationDefinition,
  ParamsOf,
  ResultOf,
  NotificationParamsOf,
  RpcErrorClass,
  RpcCapTag,
  CallablePrincipal,
  CallErrorsOf,
  DomainErrorsOf,
  CapErrorsOf,
  ResponseErrorsOf,
  PrincipalErrorClassesOf,
} from "./method.js";
export { effectiveErrorClasses } from "./method.js";

// The cast-free per-method dispatch over a non-flat `RpcClient`: the typed map
// shape `RpcClient.make(group)` conforms to, plus `dispatchCall` for tag-keyed
// dispatch. Shared by the production client and the server's reverse client.
export { dispatchCall, makeTypedTransportCall } from "./typed-dispatch.js";
export type {
  TypedDispatchMap,
  RpcForTag,
  PayloadForTag,
  SuccessForTag,
  ErrorForTag,
} from "./typed-dispatch.js";

// Transport-layer call errors — the failures that originate at the CLIENT
// transport, not at a method handler. Domain failures ride their own
// `Schema.TaggedError` class, decoded per-method against the method's
// `errorSchema` union by `_tag`.
export { NotConnectedError, RpcTimeoutError } from "./rpc-errors.js";

// Cross-cutting wire tagged-error classes. Each is a `Schema.TaggedError`: both
// the runtime failure constructor AND a wire `Schema` whose `_tag` is the
// per-method error-union discriminant the engine decodes against.
export {
  MalformedFrameError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InvalidParamsError,
  // Connect-handler wire error.
  AlreadyConnected,
  principalGateErrorClasses,
} from "./wire-errors.js";
export type { RpcErrorPayload } from "./wire-errors.js";

// Decoded RPC + notification types. Group-level decode helpers
// (`decodeRpcRequest`, `decodeNotification`) remain protocol-internal —
// consumers reach the same surface via `decodeServerInbound` and discriminate
// on `definition` identity. `isDecodedNotification` is the typed-guard
// companion the Stream-based `client.notifications`/`subscribeTo` callers use
// to narrow filtered frames to `DecodedNotification<D>`; it is part of the
// public surface.
export type { DecodedRpcRequest, DecodedNotification } from "./rpc-groups.js";
export { isDecodedNotification } from "./rpc-groups.js";

// Typed dispatcher. Per-kind static handler tables and three connection
// factories (`make{Server,AgentClient,AppClient}Connection`). Type-level
// invariants are exercised by `typed-dispatcher.types-check.ts`.
export type {
  HandlerSlot,
  AppCallbackHandlers,
  AppCallbackInboundRpcDefinition,
} from "./handlers.js";
// Reverse server→client RPC groups (the s2c channel). `ReverseRpcGroup` carries
// the moderator callbacks (`dispatch/authorize`, `messages/authorize`,
// `task/create`) ∪ every notification; `NotificationRpcGroup` carries every
// `defineNotification` as a fire-and-forget `void`-result RPC. The server holds
// the `RpcClient`; the client stands the `RpcServer` (the notification handlers
// route into the `SubscriberRegistry`).
export { NotificationRpcGroup, ReverseRpcGroup } from "./rpc-method-groups.js";

// Principal-as-service: the protocol-owned `CurrentPrincipal` Tag a cap
// middleware reads (`yield* CurrentPrincipal`) when deriving its payload.
export type { Principal } from "./current-principal.js";
export { CurrentPrincipal, callerAgentId } from "./current-principal.js";

// Channel-multiplexed `@effect/rpc` transport. One physical WebSocket
// carries every logical endpoint, split by the `{ch, f}` envelope; each
// channel owns its own serialization Parser and binds to the engine
// through the low-level `RpcServer.Protocol.make` / `RpcClient.Protocol.make`
// extension points. The live connection composes these builders.
export {
  makeServerChannelProtocol,
  makeClientChannelProtocol,
  runMuxReader,
  routeInbound,
  MUX_CLIENT_ID,
} from "./mux.js";
export type {
  MuxChannel,
  MuxEnvelope,
  WireWrite,
  ChannelProtocol,
  ChannelSink,
} from "./mux.js";

// `@effect/rpc` server engine over the mux. `ServerEngineLayer` runs
// `RpcServer` for the WS-dispatched `WsServerEngineRpcGroup`;
// `makeServerProtocolLayer` builds the `RpcServer.Protocol` over a c→s
// mux channel. The live connection composes these with
// `WsServerEngineRpcGroup.toLayer(serverHandlers)`.
export { makeServerProtocolLayer, ServerEngineLayer } from "./server-engine.js";

// The middleware-attached server engine group + the WS-dispatched subset the
// live engine binds + the unauthenticated-method allowlist that partitions it.
// `ServerEngineRpcGroup` gates every member except `UNAUTHENTICATED_METHODS`
// with that method's own `*AuthMw`; `WsServerEngineRpcGroup` is the same group
// (every catalog method is WS-dispatched), so its members map one-to-one onto
// the server's handler map. The server derives its `principalKinds` policy from
// the same single-source binding registry.
export {
  ServerEngineRpcGroup,
  WsServerEngineRpcGroup,
  WS_ENGINE_MEMBER_COUNT,
  assertWsEngineSize,
  UNAUTHENTICATED_METHODS,
  isUnauthenticatedMethod,
  findEngineGatingMismatch,
} from "./server-engine-group.js";
export type { UnauthenticatedMethod } from "./server-engine-group.js";

// §F — the two first-party client-callable group projections of the
// `serverRpcMethods` catalog, partitioned by each descriptor's
// `callablePrincipal`. An agent client types against `AgentCallableGroup`, an
// app client against `AppCallableGroup`, so a cross-principal call is a compile
// error (the runtime gate stays the untrusted-peer backstop).
export {
  AgentCallableGroup,
  AppCallableGroup,
} from "./client-callable-groups.js";

// Per-capability `@effect/rpc` middlewares. Each capability is its own
// `RpcMiddleware.Tag`; the engine stacks the principal gate plus a method's
// declared cap middlewares (`server-engine-group.ts → buildEngineMember`). Each
// cap mw `provides` its capability `Context.Tag` and carries its own `failure`
// (the cap's error union), which the engine unions into the method's wire error.
// The server supplies each mw's impl as a per-socket Layer
// (`server-core auth-middleware-layers.ts`).
export {
  PrincipalGateMw,
  ConversationInTaskMw,
  ConversationSendAccessMw,
  TaskReadAccessMw,
  ContactPolicyAllowsReachMw,
  capMiddlewareByCapKey,
  type CapMwFor,
  type MwStackFor,
} from "./cap-middlewares.js";
