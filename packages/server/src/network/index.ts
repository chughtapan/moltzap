/** @file Network-domain utilities. */

/** Re-exports the public API from `./agent-endpoint-resolver.js`. */
export {
  AgentEndpointResolver,
  agentEndpointResolverLive,
  AgentEndpointResolverTag,
} from "./agent-endpoint-resolver.js";
/** Re-exports the public API from `./connect.handlers.js`. */
export { connectAgent } from "./connect.handlers.js";
/** Re-exports the public API from `./network-send.js`. */
export {
  NetworkSendService,
  networkSendServiceLive,
  NetworkSendServiceTag,
} from "./network-send.js";
