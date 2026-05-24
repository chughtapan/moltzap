/**
 * @file Public barrel — protocol layer DAG.
 *
 * The protocol package is the leaf in the workspace dependency
 * graph, and internally it is split into five layers with their own
 * one-way dependency order. Re-exports below are arranged in DAG
 * order so the file itself is the manifest.
 *
 * ```mermaid
 * flowchart TD
 *   app[app/] --> task[task/]
 *   app --> identity[identity/]
 *   app --> transport[transport/]
 *   task --> identity
 *   task --> transport
 *   network[network/] --> identity
 *   network --> transport
 *   identity --> transport
 *   transport --> schema[schema-primitives]
 * ```
 *
 * A `task/*` method may reference `identity/*` types (e.g.
 * `AgentId`); the reverse import is forbidden. The server's
 * Tag-allowlist hierarchy in `@moltzap/server-core` mirrors this
 * DAG: a handler may pull services only from layers at-or-below its
 * own home layer.
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
