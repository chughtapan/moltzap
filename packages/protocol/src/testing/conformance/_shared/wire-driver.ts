/**
 * Wire driver — merged conformance harnesses that act AS a JSON-RPC client
 * or AS a JSON-RPC server so property tests can drive the real
 * counterparty under test.
 *
 * Phase 1B re-architect (arch-1b-r2): replaces the pre-reorg pair
 * `testing/test-client.ts` (~860 LOC) + `testing/test-server.ts` (~261 LOC).
 * The previous names oversold these files as entities being tested; their
 * actual role is test-time wire driver: `makeTestClient` opens a WebSocket
 * to a real server and exposes typed `request` / `notify` / `handleServerRpc`
 * primitives; `makeTestServer` accepts an inbound WebSocket and exposes the
 * same primitives in the opposite direction so client-side conformance can
 * drive the real client.
 *
 * Both factories return resource handles that compose under `Effect.scoped`
 * + `Effect.acquireRelease`; the merged file keeps a single `CapturedFrame`
 * journal type and one `TestingError` channel.
 *
 * Architect stub — implementer fills in by porting the existing module
 * bodies verbatim and rewriting their relative imports to the new
 * conformance/_shared/ paths.
 */

// Public exports (preserved verbatim from `testing/test-client.ts` +
// `testing/test-server.ts`; the barrel at `testing/index.ts` re-exports
// these names unchanged so external consumers see no surface drift).

export type CloseableTestClient = never;
export type TestClient = never;
export type TestClientConfig = never;
export type TestServer = never;
export type TestServerConfig = never;
export type TestServerConnection = never;

export function makeCloseableTestClient(): never {
  throw new Error(
    "wire-driver.makeCloseableTestClient: stub — implementer to port from testing/test-client.ts",
  );
}

export function makeTestClient(): never {
  throw new Error(
    "wire-driver.makeTestClient: stub — implementer to port from testing/test-client.ts",
  );
}

export function makeTestServer(): never {
  throw new Error(
    "wire-driver.makeTestServer: stub — implementer to port from testing/test-server.ts",
  );
}
