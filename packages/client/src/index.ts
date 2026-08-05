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
/** Re-exports the adapter-facing daemon client capability. */
export {
  acquireHarnessClient,
  HarnessClient,
  makeHarnessClientLayer,
  type HarnessClientOptions,
  type HarnessClientService,
  type HarnessTurn,
} from "./harness-client.js";
