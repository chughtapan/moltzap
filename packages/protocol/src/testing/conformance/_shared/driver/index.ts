/**
 * @file Lifecycle-backed conformance client barrel.
 */

/** Re-exports the public API from `./test-client.js`. */
export {
  type AgentTestClient,
  type AgentTestClientConfig,
  type CloseableAgentTestClient,
  type NotificationClient,
  makeAgentTestClient,
  makeCloseableAgentTestClient,
} from "./test-client.js";
