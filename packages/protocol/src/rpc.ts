/**
 * @file Public RPC support surface.
 *
 * Domain descriptors stay behind the domain barrels. This module exposes the
 * generic call-site helpers, subscriber registry, pagination cursor, and shared
 * wire error classes needed by protocol consumers without publishing the
 * descriptor-construction transport layer.
 */

// safer-arch-ignore no-public-vendor-type-leak: This facade re-exports protocol's own #transport subpath, which is package-owned rather than a vendor boundary. Tracked upstream: chughtapan/safer-architecture-lsp#2.
// safer-arch-ignore require-boundary-owned-types: This facade deliberately exposes package-owned #transport RPC support types. Tracked upstream: chughtapan/safer-architecture-lsp#2.

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
} from "#transport";
export { isNotificationDeliveryFor } from "#transport";

export {
  makeNotificationSubscriberRegistry,
  notificationSubscribe,
  notificationSubscribeAll,
} from "#transport";
export type {
  NotificationSubscriberRegistry,
  NotificationSubscriberRegistryOptions,
  NotificationSubscriptionHandle,
} from "#transport";

export { dispatchCall, makeTypedTransportCall } from "#transport";
export type {
  ErrorForTag,
  PayloadForTag,
  RpcForTag,
  SuccessForTag,
  TypedDispatchMap,
} from "#transport";

export {
  DEFAULT_PAGE_LIMIT,
  ListLimitSchema,
  MAX_PAGE_LIMIT,
  listCursorSchema,
} from "#transport";
export type { ListCursor } from "#transport";

export { NotConnectedError, RpcTimeoutError } from "#transport";

export {
  AlreadyConnected,
  ConflictError,
  ForbiddenError,
  InvalidParamsError,
  NotFoundError,
  UnauthorizedError,
} from "#transport";
export type { RpcErrorPayload } from "#transport";
