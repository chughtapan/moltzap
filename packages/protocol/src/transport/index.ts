/**
 * @file Public barrel for JSON-RPC transport descriptors and runtime helpers.
 */
// RPC + notification descriptor types. Effect RPC owns frame decoding; these
// descriptors own per-method payload/result schemas and the client subscription
// notification envelope produced after native decode.
export type {
  JsonRpcId,
  JsonRpcMethod,
  RpcDefinition,
  NotificationDefinition,
  ParamsOf,
  ResultOf,
  NotificationParamsOf,
  NotificationDelivery,
  RpcErrorClass,
  CallErrorsOf,
  DomainErrorsOf,
  RequirementErrorsOf,
  ResponseErrorsOf,
} from "./method.js";
export { effectiveErrorClasses, jsonRpcMethod } from "./method.js";

export {
  makeNotificationSubscriberRegistry,
  notificationSubscribe,
  notificationSubscribeAll,
} from "./notification-subscribers.js";
export type {
  NotificationSubscriberRegistry,
  NotificationSubscriberRegistryOptions,
  NotificationSubscriptionHandle,
} from "./notification-subscribers.js";

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

// The principal + refinement requirement tags — the low head of a method's
// `requires` list, depended on DOWNWARD by every domain descriptor.
// `AgentPrincipal`/`AppPrincipal` narrow the connection to that arm;
// `AgentClaimed` (agent-only) refines to a claimed agent. The capability half of
// the requirement model + `CurrentPrincipal` live in the engine layer (above
// the domains), surfaced through the package's main barrel.
export { AgentPrincipal, AppPrincipal, AgentClaimed } from "./principal.js";
export type { PrincipalRequirement } from "./principal.js";

// Two-engine `@effect/rpc` transport. One physical WebSocket carries a local
// `RpcServer` and a local `RpcClient`; inbound frames route to one or the other
// by frame family (a `method` marks the request family). Both engines bind
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
  SocketSinks,
  WireWrite,
  ChannelProtocol,
  ChannelSink,
} from "./mux.js";
