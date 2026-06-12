/**
 * @file Public RPC support surface.
 *
 * Domain descriptors stay behind the domain barrels. This module exposes the
 * generic call-site helpers, subscriber registry, pagination cursor, and shared
 * wire error classes needed by protocol consumers without publishing the
 * descriptor-construction transport layer.
 */

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
  RpcErrorClass,
} from "../transport/method.js";
export { isNotificationDeliveryFor } from "../transport/method.js";

export {
  makeNotificationSubscriberRegistry,
  notificationSubscribe,
  notificationSubscribeAll,
} from "../transport/notification-subscribers.js";
export type {
  NotificationSubscriberRegistry,
  NotificationSubscriberRegistryOptions,
  NotificationSubscriptionHandle,
} from "../transport/notification-subscribers.js";

export {
  dispatchCall,
  makeTypedTransportCall,
} from "../transport/typed-dispatch.js";
export type {
  ErrorForTag,
  PayloadForTag,
  RpcForTag,
  SuccessForTag,
  TypedDispatchMap,
} from "../transport/typed-dispatch.js";

export {
  DEFAULT_PAGE_LIMIT,
  ListLimitSchema,
  MAX_PAGE_LIMIT,
  listCursorSchema,
} from "../transport/pagination.js";
export type { ListCursor } from "../transport/pagination.js";

export { NotConnectedError, RpcTimeoutError } from "../transport/rpc-errors.js";

export {
  AlreadyConnected,
  ConflictError,
  ForbiddenError,
  InvalidParamsError,
  NotFoundError,
  UnauthorizedError,
} from "../transport/wire-errors.js";
export type { RpcErrorPayload } from "../transport/wire-errors.js";
