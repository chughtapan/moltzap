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
// consumers go through `decodeServerInbound` / `decodeClientInbound`
// (rpc-registry.ts) or per-def `validateParams`.
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
  // D #705 §3.1 — Connect-handler wire error.
  AlreadyConnected,
  principalGateErrorClasses,
} from "./wire-errors.js";
export type { RpcErrorPayload } from "./wire-errors.js";

// Decoded RPC + notification types. Group-level decode helpers
// (`decodeRpcRequest`, `decodeNotification`) remain protocol-internal —
// consumers reach the same surface via `decodeServerInbound` /
// `decodeClientInbound` and discriminate on `definition` identity.
// `isDecodedNotification` is the typed-guard companion that Spec B
// (#596) Stream-based `client.notifications`/`subscribeTo` callers use to
// narrow filtered frames to `DecodedNotification<D>`; it is part of the
// public surface.
export type { DecodedRpcRequest, DecodedNotification } from "./rpc-groups.js";
export { isDecodedNotification } from "./rpc-groups.js";

// Spec F (#617) — typed dispatcher. Per-kind static handler tables and
// three connection factories (`make{Server,AgentClient,AppClient}Connection`).
// Type-level invariants are exercised by `typed-dispatcher.types-check.ts`.
export type {
  HandlerSlot,
  AppCallbackHandlers,
  AppCallbackInboundRpcDefinition,
} from "./handlers.js";
// Reverse server→client RPC groups (the s2c channel). `AppCallbackRpcGroup`
// carries the moderator callbacks (`dispatch/authorize`, `messages/authorize`,
// `task/create`); `NotificationRpcGroup` carries every `defineNotification` as
// a fire-and-forget `void`-result RPC. The server holds the `RpcClient`; the
// client stands the `RpcServer` (the notification handlers route into the
// `SubscriberRegistry`).
export {
  AppCallbackRpcGroup,
  NotificationRpcGroup,
  ReverseRpcGroup,
  ServerRpcGroup,
} from "./rpc-method-groups.js";

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
} from "./native-mux.js";
export type {
  MuxChannel,
  MuxEnvelope,
  WireWrite,
  ChannelProtocol,
  ChannelSink,
} from "./native-mux.js";

// Native `@effect/rpc` server engine over the mux. `ServerEngineLayer` runs
// `RpcServer` for the WS-dispatched `WsServerEngineRpcGroup`;
// `makeServerProtocolLayer` builds the `RpcServer.Protocol` over a c→s
// native-mux channel. The live connection composes these with
// `WsServerEngineRpcGroup.toLayer(serverNativeHandlers)`.
export {
  makeServerProtocolLayer,
  ServerEngineLayer,
} from "./native-server-engine.js";

// The middleware-attached server engine group + the WS-dispatched subset the
// live engine binds + the unauthenticated-method allowlist that partitions it.
// `ServerEngineRpcGroup` gates every member except `UNAUTHENTICATED_METHODS`
// with that method's own `*AuthMw`; `WsServerEngineRpcGroup` is that group minus
// the HTTP-only methods (which have no WS handler), so its members map one-to-one
// onto the server's handler map. The server derives its `principalKinds` policy
// from the same single-source binding registry.
export {
  ServerEngineRpcGroup,
  WsServerEngineRpcGroup,
  WS_ENGINE_MEMBER_COUNT,
  assertWsEngineSize,
  UNAUTHENTICATED_METHODS,
  isUnauthenticatedMethod,
  findEngineGatingMismatch,
} from "./server-engine-group.js";
export type {
  UnauthenticatedMethod,
  HttpOnlyMethod,
} from "./server-engine-group.js";

// §F — the two first-party client-callable group projections of the
// `serverRpcMethods` catalog, partitioned by each descriptor's
// `callablePrincipal`. An agent client types against `AgentCallableGroup`, an
// app client against `AppCallableGroup`, so a cross-principal call is a compile
// error (the runtime gate stays the untrusted-peer backstop).
export {
  AgentCallableGroup,
  AppCallableGroup,
} from "./client-callable-groups.js";

// §H — the per-method `AuthContext` proof tags + their `AuthMiddleware`
// descriptors. Each authenticated method carries ONE native `RpcMiddleware`
// whose `provides` is that method's proof tag; the middleware impl (server
// per-socket `Layer`) resolves the principal, runs the method's caps with the
// principal in scope, and provides the combined `{ principal, <cap proofs> }`
// proof. The proof VALUE type is projected from the descriptor's
// `callablePrincipal` + `caps` (`AuthProof`), so it cannot drift.
export type {
  CapProofs,
  AuthContextValue,
  PrincipalForKind,
} from "./auth-context.js";
export type { AuthProof } from "./auth-middleware.js";
export {
  MessagesSendAuth,
  MessagesSendAuthMw,
  MessagesListAuth,
  MessagesListAuthMw,
  TaskListAuth,
  TaskListAuthMw,
  TaskRequestAuth,
  TaskRequestAuthMw,
  TaskLeaveAuth,
  TaskLeaveAuthMw,
  TaskConversationListAuth,
  TaskConversationListAuthMw,
  AgentsLookupAuth,
  AgentsLookupAuthMw,
  AgentsLookupByNameAuth,
  AgentsLookupByNameAuthMw,
  AgentsListAuth,
  AgentsListAuthMw,
  ContactsListAuth,
  ContactsListAuthMw,
  ContactsAddAuth,
  ContactsAddAuthMw,
  ContactsAcceptAuth,
  ContactsAcceptAuthMw,
  ContactsByIdAuth,
  ContactsByIdAuthMw,
  DispatchRequestAuth,
  DispatchRequestAuthMw,
  NetworkPingAuth,
  NetworkPingAuthMw,
  PresenceSubscribeAuth,
  PresenceSubscribeAuthMw,
  TaskCloseAuth,
  TaskCloseAuthMw,
  TaskAddParticipantAuth,
  TaskAddParticipantAuthMw,
  TaskRemoveParticipantAuth,
  TaskRemoveParticipantAuthMw,
  TaskConversationCreateAuth,
  TaskConversationCreateAuthMw,
  TaskConversationArchiveAuth,
  TaskConversationArchiveAuthMw,
  TaskConversationUnarchiveAuth,
  TaskConversationUnarchiveAuthMw,
  TaskConversationAddParticipantAuth,
  TaskConversationAddParticipantAuthMw,
  TaskConversationRemoveParticipantAuth,
  TaskConversationRemoveParticipantAuthMw,
  AppsRegisterAuth,
  AppsRegisterAuthMw,
  DispatchesGetAuth,
  DispatchesGetAuthMw,
} from "./auth-middleware.js";
