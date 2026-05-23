/**
 * @file Root public barrel for the complete protocol package.
 */
export { PROTOCOL_VERSION } from "./version.js";

export * from "./transport/index.js";
export * from "./identity/index.js";
export * from "./network/index.js";
export * from "./task/index.js";
export * from "./app/index.js";

export {
  serverRpcMethods,
  agentClientRpcMethods,
  taskMasterRpcMethods,
  notificationDefinitions,
  decodeServerInbound,
  decodeClientInbound,
} from "./rpc-registry.js";
export type {
  AnyServerRpcDefinition,
  AnyAgentClientRpcDefinition,
  AnyTaskMasterRpcDefinition,
  AnyTaskCallbackRpcDefinition,
  AnyNotificationDefinition,
  DecodedServerInbound,
  DecodedClientInbound,
  DecodedResponseSuccess,
  DecodedResponseError,
  RegisteredTaggedError,
} from "./rpc-registry.js";
