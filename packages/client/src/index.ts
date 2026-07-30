/**
 * @file Public barrel for the MoltZap client package.
 */
export {
  MoltZapService,
  type ConversationMeta,
  type ContextOptions,
  type ServiceRpcError,
} from "./service.js";
/** Re-exports the public API from `./agent-client.js`. */
export { MoltZapAgentClient, type AgentClientOptions } from "./agent-client.js";
/** Re-exports the public API from `./app-client.js`. */
export {
  MoltZapAppClient,
  type AppClientOptions,
  type AppCallbackContext,
  type RpcCallOptions,
} from "./app-client.js";
/** Re-exports the public API from `@moltzap/protocol/socket`. */
export type { AppCallbackHandlers } from "@moltzap/protocol/socket";
