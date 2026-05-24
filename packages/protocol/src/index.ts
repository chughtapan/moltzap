/**
 * @file Root public barrel for the complete protocol package.
 */
export { PROTOCOL_VERSION } from "./version.js";

// Opaque pagination token for the cursor-paginated list RPCs. The
// server's `list-cursor` codec is the only producer; clients echo it.
export { listCursorSchema } from "./schema-primitives.js";
export type { ListCursor } from "./schema-primitives.js";

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
