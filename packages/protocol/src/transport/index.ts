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
  CallErrorsOf,
  DomainErrorsOf,
  RequirementErrorsOf,
  ResponseErrorsOf,
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

// The principal + refinement requirement tags — the low head of a method's
// `requires` list, depended on DOWNWARD by every domain descriptor.
// `AgentPrincipal`/`AppPrincipal` narrow the connection to that arm;
// `AgentClaimed` (agent-only) refines to a claimed agent. The capability half of
// the requirement model + `CurrentPrincipal` live in the engine layer (above
// the domains), surfaced through the package's main barrel.
export { AgentPrincipal, AppPrincipal, AgentClaimed } from "./principal.js";
export type { PrincipalRequirement } from "./principal.js";

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
