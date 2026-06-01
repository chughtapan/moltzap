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
} from "./method.js";

// Transport-layer call errors (raised by Originator + ws-client).
export {
  NotConnectedError,
  RpcTimeoutError,
  RpcServerError,
} from "./rpc-errors.js";

// Wire-coded tagged errors. `registerErrorClass` is intentionally NOT
// re-exported here: the registered-class set is closed (mirrored by the
// `RegisteredTaggedError` union in `rpc-registry.ts`); protocol-internal
// classes self-register via relative imports of `./wire-errors.js`.
export {
  JSON_RPC_RESERVED_CODES,
  MalformedFrameError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InvalidParamsError,
  // D #705 §3.1 — Connect-handler wire error.
  AlreadyConnected,
  // Read-only registry predicate — lets a consumer (e.g. the CLI transport)
  // recognise any registered wire-error instance and recover its static
  // `code`/`message`. Does NOT expose `registerErrorClass`: the registered set
  // stays closed.
  isRegisteredErrorInstance,
} from "./wire-errors.js";
export type { RpcErrorClass, RpcErrorPayload } from "./wire-errors.js";

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

// JSON-RPC originator error surface — outbound RPC error type used by
// every `Connection.call` signature.
export type { RpcCallError } from "./originator.js";

// Spec F (#617) — typed dispatcher. Per-kind static handler tables and
// three connection factories (`make{Server,AgentClient,AppClient}Connection`).
// Type-level invariants are exercised by `typed-dispatcher.types-check.ts`.
export type {
  HandlerSlot,
  AppCallbackHandlers,
  AppCallbackInboundRpcDefinition,
} from "./handlers.js";
export type {
  ServerConnection,
  AgentClientConnection,
  AppClientConnection,
  ServerConnectionConfig,
  AgentClientConnectionConfig,
  AppClientConnectionConfig,
} from "./connection.js";
export {
  makeServerConnection,
  makeAgentClientConnection,
  makeAppClientConnection,
} from "./connection.js";
export {
  buildServerDispatcher,
  buildAgentClientDispatcher,
  buildAppClientDispatcher,
  wireErrorFromInstance,
} from "./dispatch.js";
export type { WireError } from "./dispatch.js";

// #705 — the existential `ErasedSlot` the dispatcher indexes by runtime
// method string (supersedes the `RpcMethodBinding[]` + erasure-cast
// cascade). Every slot is built by `makeMiddlewareSlot` (HALF-2); the
// legacy `makeErasedSlot` + `dischargeCaps` + positional `CapProviders`
// tuple + `argsOf` erasure are gone.
export type {
  ErasedSlot,
  ErasedSlotTable,
  SlotDispatchContext,
} from "./erased-slot.js";

// #705 HALF-2 — principal-as-service + cap-as-middleware. The
// cast-free successor surface for middleware-converted methods: the
// protocol-owned `CurrentPrincipal` Tag (read via `yield*` in
// `derivePayload`), the `CapabilityMiddleware` carrier, and the
// `makeMiddlewareSlot` builder (no `dischargeCaps` runtime fold, no
// `narrowToDispatchContext`, no `argsOf(unknown, unknown)` erasure).
export type { Principal } from "./current-principal.js";
export { CurrentPrincipal, callerAgentId } from "./current-principal.js";
export type {
  CapabilityMiddleware,
  AnyCapabilityMiddleware,
  MiddlewaresOf,
} from "./capability-middleware.js";
export { provideMiddleware } from "./capability-middleware.js";
export type { GatedMiddlewareBody } from "./middleware-slot.js";
export { makeMiddlewareSlot } from "./middleware-slot.js";

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
// `RpcServer` for the middleware-attached `ServerEngineRpcGroup`;
// `makeServerProtocolLayer` builds the `RpcServer.Protocol` over a c→s
// native-mux channel; `PrincipalResolution` is the middleware descriptor
// providing `CurrentPrincipal`. The live connection composes these with
// `ServerEngineRpcGroup.toLayer(handlers)`.
export {
  PrincipalResolution,
  makeServerProtocolLayer,
  ServerEngineLayer,
} from "./native-server-engine.js";

// The middleware-attached server engine group + the unauthenticated-method
// allowlist that partitions it. `ServerEngineRpcGroup` gates every member
// except `UNAUTHENTICATED_METHODS` with `PrincipalResolution`; the server
// binds its handler map and derives its `principalKinds` policy from the same
// single-source binding registry.
export {
  ServerEngineRpcGroup,
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
