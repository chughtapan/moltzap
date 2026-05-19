/**
 * @file Wire-driver harness barrel for the `_shared/driver/` sub-folder.
 *
 * The `driver/` folder contains test-time JSON-RPC wire harnesses.
 *
 * These harnesses act as a counterparty for property tests.
 *
 * The folder currently contains `test-client.ts` and `test-server.ts`.
 * Future wire-driver helpers belong here. Other helpers belong elsewhere.
 *
 * Re-exporting keeps external consumers on the public testing entrypoint.
 */

export {
  type CloseableTestClient,
  ServerRequestWaitError,
  type ServerRpcContext,
  type ServerRpcDefinition,
  type ServerRpcParams,
  type ServerRpcResult,
  type TestClient,
  type TestClientConfig,
  makeCloseableTestClient,
  makeTestClient,
} from "./test-client.js";

export {
  type TestServer,
  type TestServerConfig,
  type TestServerConnection,
  makeTestServer,
} from "./test-server.js";
