/**
 * @file Lifecycle-backed conformance client barrel.
 */

export {
  type AgentTestClient,
  type AgentTestClientConfig,
  type AppTestClient,
  type AppTestClientConfig,
  type CloseableAgentTestClient,
  type CloseableAppTestClient,
  makeAgentTestClient,
  makeAppTestClient,
  makeCloseableAgentTestClient,
  makeCloseableAppTestClient,
  type NotificationClient,
  ServerRequestWaitError,
  type ServerRpcContext,
  type ServerRpcDefinition,
  type ServerRpcParams,
  type ServerRpcResult,
} from "./test-client.js";
