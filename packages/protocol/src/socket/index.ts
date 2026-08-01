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
export type { AppCallbackHandlers, HandlerSlot } from "./app-callbacks.js";

export {
  openProtocolAgentClientSocket,
  openProtocolAppClientSocket,
  ProtocolClientLifecycle,
  RPC_TIMEOUT_MS,
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

export { MoltZapServer } from "./server.js";
export type {
  MoltZapServerOptions,
  MoltZapServerSession,
  ReverseCallbackError,
  ReverseCallbackPayload,
  ReverseCallbackRequest,
  ReverseCallbackSuccess,
  ReverseCallbackTag,
  ReverseCallError,
  ReverseClient,
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
  isDispatchAuthorizeRequest,
  isMessagesAuthorizeRequest,
  isTaskCreateRequest,
} from "./reverse-callbacks.js";
