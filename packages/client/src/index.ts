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
export {
  MoltZapAgentClient,
  type AgentClientOptions,
  type RpcCallOptions,
} from "./agent-client.js";
