/**
 * @file Public barrel for the MoltZap client package.
 */
export {
  type ContextOptions,
  type ConversationMeta,
  MoltZapService,
  type ServiceRpcError,
} from "./service.js";
/** Re-exports the public API from `./agent-client.js`. */
export {
  type AgentClientOptions,
  MoltZapAgentClient,
  type RpcCallOptions,
} from "./agent-client.js";
/** Re-exports the adapter-facing daemon client capability. */
export {
  acquireHarnessClient,
  HarnessClient,
  type HarnessClientOptions,
  type HarnessClientService,
  type HarnessTurn,
  makeHarnessClientLayer,
} from "./harness-client.js";
