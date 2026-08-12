/** @file Internal RPC and notification descriptor construction surface. */

/** Re-exports the public API from `./definition.js`. */
export type {
  NotificationDefinition,
  NotificationDefinitionAny,
  RpcDefinition,
  RpcDefinitionAny,
} from "./definition.js";
/** Re-exports the public API from `./definition.js`. */
export {
  defineNotification,
  defineRpc,
  effectiveErrorClasses,
  jsonRpcMethod,
} from "./definition.js";
