/**
 * @file Socket lifecycle surface for protocol-owned clients and server.
 *
 * Owns the concrete MoltZap agent client, app client, server socket lifecycle,
 * connection identifiers, close-info extraction, and socket-local lifecycle
 * helpers used by testing and server wiring.
 */

export { MoltZapAgentClient } from "./agent-client.js";
export type { AgentClientOptions } from "./agent-client.js";

export { MoltZapAppClient } from "./app-client.js";
export type { AppCallbackContext, AppClientOptions } from "./app-client.js";
export type {
  AppCallbackHandlers,
  AppCallbackRpcDefinition,
  HandlerSlot,
} from "./app-callbacks.js";

export {
  RPC_TIMEOUT_MS,
  openProtocolAgentClientSocket,
  openProtocolAppClientSocket,
  ProtocolClientLifecycle,
} from "./lifecycle.js";
export type {
  ClientConnectError,
  ClientDefinitionError,
  ClientDefinitionPayload,
  ClientDefinitionSuccess,
  ClientRpcDefinition,
  ConnectResult,
  ReverseCallbackHandlers,
  RpcCallOptions,
} from "./lifecycle.js";

export { MoltZapServer, makeServerProtocolLayer } from "./server.js";
export type {
  MoltZapServerOptions,
  MoltZapServerSession,
  ReverseCallError,
  ReverseCallbackError,
  ReverseCallbackPayload,
  ReverseCallbackRequest,
  ReverseCallbackSuccess,
  ReverseCallbackTag,
  ReverseClient,
  ServerHandler,
  ServerHandlers,
  ServerSocketWrite,
} from "./server.js";

export {
  classifyCloseCause,
  DEFAULT_ABNORMAL_CLOSE,
  DEFAULT_GRACEFUL_CLOSE,
  extractCloseInfo,
} from "./close-info.js";
export type { CloseInfo, CloseKind } from "./close-info.js";

export { ConnectionId, connectionId, newConnectionId } from "./connection.js";

export {
  agentCallableMethods,
  appCallableMethods,
  appCallbackMethods,
  serverInboundMethods,
  notificationDefinitions,
  AgentCallableGroup,
  AppCallableGroup,
  NotificationRpcGroup,
  ReverseRpcGroup,
} from "./catalog.js";
export type {
  AnyServerRpcDefinition,
  AnyAgentCallableRpcDefinition,
  AnyAppCallableRpcDefinition,
  AnyAppCallbackRpcDefinition,
  AnyNotificationDefinition,
} from "./catalog.js";
