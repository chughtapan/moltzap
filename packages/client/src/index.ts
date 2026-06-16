/**
 * @file Public barrel for the MoltZap client package.
 */
export {
  MoltZapService,
  type ConversationMeta,
  type ContextOptions,
  type ServiceRpcError,
} from "./service.js";
export { MoltZapAgentClient, type AgentClientOptions } from "./agent-client.js";
export {
  MoltZapAppClient,
  type AppClientOptions,
  type AppCallbackContext,
  type RpcCallOptions,
} from "./app-client.js";
export type { AppCallbackHandlers } from "@moltzap/protocol/socket";
