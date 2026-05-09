/**
 * Wire-driver harness — barrel for the `_shared/driver/` sub-folder.
 *
 * `driver/` is the coherent home for test-time JSON-RPC wire harnesses
 * that act AS a counterparty (client or server) so property tests can
 * drive the real implementation under test. Today it contains
 * `test-client.ts` and `test-server.ts`; if a future helper is
 * narrowly a wire-driver harness piece, it joins this folder. If it
 * is not, it lives elsewhere — `driver/` is not a dump.
 *
 * Re-exported through `testing/index.ts` so external consumers continue
 * to import `makeTestClient` / `makeTestServer` / etc. from
 * `@moltzap/protocol/testing` with no path-aware changes on their side.
 */

export {
  type CloseableTestClient,
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
