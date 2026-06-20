/** @file Internal RPC and notification descriptor construction surface. */

export type {
  NotificationDefinition,
  NotificationDefinitionAny,
  RpcDefinition,
  RpcDefinitionAny,
} from "./definition.js";
export {
  decodeRpcResult,
  defineNotification,
  defineRpc,
  effectiveErrorClasses,
  jsonRpcMethod,
} from "./definition.js";
