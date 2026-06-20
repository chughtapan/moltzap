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
  type NotificationClient,
  ServerRequestWaitError,
  type ServerRpcContext,
  type ServerRpcDefinition,
  type ServerRpcParams,
  type ServerRpcResult,
  makeAgentTestClient,
  makeAppTestClient,
  makeCloseableAgentTestClient,
  makeCloseableAppTestClient,
} from "./test-client.js";
