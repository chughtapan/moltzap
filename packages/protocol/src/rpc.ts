/**
 * @file Public RPC support surface.
 *
 * Domain descriptors stay behind the domain barrels. This module exposes the
 * generic call-site helpers, subscriber registry, pagination cursor, and shared
 * wire error classes needed by protocol consumers without publishing the
 * descriptor-construction transport layer.
 */

/** Re-exports the public API from `#transport`. */
export type {
  CallErrorsOf,
  DomainErrorsOf,
  NotificationDefinition,
  NotificationDelivery,
  NotificationParamsOf,
  NotificationPayloadOf,
  ParamsOf,
  RequirementErrorsOf,
  ResponseErrorsOf,
  ResultOf,
  RpcDefinition,
  RpcDefinitionAny,
  RpcErrorClass,
} from "#transport";
/** Re-exports the public API from `#transport`. */
export { isNotificationDeliveryFor } from "#transport";

/** Re-exports the public API from `#transport`. */
export {
  makeNotificationSubscriberRegistry,
  notificationSubscribe,
  notificationSubscribeAll,
} from "#transport";
/** Re-exports the public API from `#transport`. */
export type {
  NotificationSubscriberRegistry,
  NotificationSubscriberRegistryOptions,
  NotificationSubscriptionHandle,
} from "#transport";

/** Re-exports the public API from `#transport`. */
export { dispatchCall, makeTypedTransportCall } from "#transport";
/** Re-exports the public API from `#transport`. */
export type {
  ErrorForTag,
  PayloadForTag,
  RpcForTag,
  SuccessForTag,
  TypedDispatchMap,
} from "#transport";

/** Re-exports the public API from `#transport`. */
export {
  DEFAULT_PAGE_LIMIT,
  listLimitSchema,
  MAX_PAGE_LIMIT,
  listCursorSchema,
} from "#transport";
/** Re-exports the public API from `#transport`. */
export type { ListCursor } from "#transport";

/** Re-exports the public API from `#transport`. */
export { NotConnectedError, RpcTimeoutError } from "#transport";

/** Re-exports the public API from `#transport`. */
export {
  AlreadyConnected,
  ConflictError,
  ForbiddenError,
  InvalidParamsError,
  NotFoundError,
  UnauthorizedError,
} from "#transport";
/** Re-exports the public API from `#transport`. */
export type { RpcErrorPayload } from "#transport";
