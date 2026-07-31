/**
 * @file Socket lifecycle surface for protocol-owned clients and server.
 *
 * Owns the concrete MoltZap agent client, app client, server socket lifecycle,
 * connection identifiers, close-info extraction, and socket-local lifecycle
 * helpers used by testing and server wiring.
 */
// safer-arch-ignore no-large-public-surface: Socket is the stable compatibility facade for clients, server lifecycle, close semantics, and reverse callbacks.

/** Re-exports the public API from `./agent-client.js`. */
export { MoltZapAgentClient } from "./agent-client.js";
/** Re-exports the public API from `./agent-client.js`. */
export type { AgentClientOptions } from "./agent-client.js";

/** Re-exports the public API from `./app-client.js`. */
export { MoltZapAppClient } from "./app-client.js";
/** Re-exports the public API from `./app-client.js`. */
export type { AppCallbackContext, AppClientOptions } from "./app-client.js";
/** Re-exports the public API from `./app-callbacks.js`. */
export type { AppCallbackHandlers, HandlerSlot } from "./app-callbacks.js";

/** Re-exports the public API from `./lifecycle.js`. */
export {
  RPC_TIMEOUT_MS,
  openProtocolAgentClientSocket,
  openProtocolAppClientSocket,
  ProtocolClientLifecycle,
} from "./lifecycle.js";
/** Re-exports the public API from `./lifecycle.js`. */
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

/** Re-exports the public API from `./server.js`. */
export { MoltZapServer } from "./server.js";
/** Re-exports the public API from `./server.js`. */
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
  ServerSocketWrite,
} from "./server.js";

/** Re-exports the public API from `./close-info.js`. */
export {
  classifyCloseCause,
  DEFAULT_ABNORMAL_CLOSE,
  DEFAULT_GRACEFUL_CLOSE,
  extractCloseInfo,
} from "./close-info.js";
/** Re-exports the public API from `./close-info.js`. */
export type { CloseInfo, CloseKind } from "./close-info.js";

/** Re-exports the public API from `./connection.js`. */
export {
  type ConnectionId,
  connectionIdSchema,
  connectionId,
  newConnectionId,
} from "./connection.js";

/** Re-exports the public API from `./reverse-callbacks.js`. */
export {
  isDispatchAuthorizeRequest,
  isMessagesAuthorizeRequest,
} from "./reverse-callbacks.js";
