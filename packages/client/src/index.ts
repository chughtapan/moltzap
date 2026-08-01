/**
 * @file Public barrel for the MoltZap client package.
 */
export {
  type ContextOptions,
  type ConversationMeta,
  MoltZapService,
  type ServiceRpcError,
} from "./service.js";
export { type AgentClientOptions, MoltZapAgentClient } from "./agent-client.js";
export {
  type AppCallbackContext,
  type AppClientOptions,
  MoltZapAppClient,
  type RpcCallOptions,
} from "./app-client.js";
export type { AppCallbackHandlers } from "@moltzap/protocol/socket";
