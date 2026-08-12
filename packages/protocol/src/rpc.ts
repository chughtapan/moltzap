/**
 * @file Public RPC support surface.
 *
 * Domain descriptors stay behind the domain barrels. This module exposes the
 * call-site types, pagination cursor, and shared wire errors used by protocol
 * consumers without publishing the descriptor-construction transport layer.
 */

/** Re-exports the public API from `#transport`. */
export type {
  NotificationDelivery,
  NotificationParamsOf,
  ParamsOf,
  ResultOf,
  RpcDefinitionAny,
} from "#transport";
/** Re-exports the public API from `#transport`. */
export { isNotificationDeliveryFor } from "#transport";

/** Re-exports the public API from `#transport`. */
export type { PayloadForTag, SuccessForTag } from "#transport";

/** Re-exports the public API from `#transport`. */
export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  listCursorSchema,
} from "#transport";
/** Re-exports the public API from `#transport`. */
export type { ListCursor } from "#transport";

/** Re-exports the public API from `#transport`. */
export { NotConnectedError, RpcTimeoutError } from "#transport";

/** Re-exports the public API from `#transport`. */
export {
  ConflictError,
  ForbiddenError,
  InvalidParamsError,
  UnauthorizedError,
} from "#transport";
