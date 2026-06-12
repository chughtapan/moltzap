/**
 * @file Public barrel for JSON-RPC transport descriptors and runtime helpers.
 */
// RPC + notification descriptor types. Effect RPC owns frame decoding; these
// descriptors own per-method payload/result schemas and the client subscription
// notification envelope produced after native decode.
export type {
  RpcDefinition,
  RpcDefinitionAny,
  NotificationDefinition,
  NotificationDefinitionAny,
  ParamsOf,
  ResultOf,
  NotificationPayloadOf,
  NotificationParamsOf,
  NotificationDelivery,
  RpcErrorClass,
  CallErrorsOf,
  DomainErrorsOf,
  RequirementErrorsOf,
  ResponseErrorsOf,
} from "./definition.js";
export {
  decodeRpcResult,
  defineNotification,
  defineRpc,
  effectiveErrorClasses,
  jsonRpcMethod,
} from "./definition.js";
export { isNotificationDeliveryFor } from "./definition.js";

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

export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  ListLimitSchema,
  listCursorSchema,
} from "./pagination.js";
export type { ListCursor } from "./pagination.js";

export { closedStructGuard, decodesStrictly } from "./strict-decode.js";

export {
  dateTimeStringSchema,
  formatString,
  stringEnum,
} from "./wire-string.js";

// Transport-layer call errors: the failures that originate at the CLIENT
// transport, not at a method handler. Domain failures ride their own
// `Schema.TaggedError` class, decoded per-method against the method's
// `errorSchema` union by `_tag`.
export { NotConnectedError, RpcTimeoutError } from "./rpc-errors.js";

// Cross-cutting wire tagged-error classes. Each is a `Schema.TaggedError`: both
// the runtime failure constructor AND a wire `Schema` whose `_tag` is the
// per-method error-union discriminant the engine decodes against.
export {
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

export {
  makeClientChannelProtocol,
  makeServerChannelProtocol,
  runMuxReader,
} from "./mux.js";
export type { ChannelSink, WireWrite } from "./mux.js";
