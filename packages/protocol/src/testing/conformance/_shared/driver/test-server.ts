/**
 * Test server — wire harness that acts AS a JSON-RPC server to drive a
 * real client under test.
 *
 * Phase 1B re-architect (arch-1b-r2): preserves the pre-reorg
 * `testing/test-server.ts` (~261 LOC) as its own file under the new
 * `conformance/_shared/driver/` sub-folder. The file's role (test-time
 * wire driver in the opposite direction) is documented at the
 * `driver/` package boundary; the file name stays `test-server.ts`
 * because that is what the file is.
 *
 * Sibling to `driver/test-client.ts`. Both share the `CapturedFrame`
 * journal type and the `TestingError` channel.
 *
 * Architect stub — implementer ports the existing module body verbatim
 * and rewrites relative imports to the new `conformance/_shared/`
 * neighbours.
 */

// Public exports (preserved verbatim from the pre-reorg `testing/test-server.ts`;
// the barrel at `testing/index.ts` re-exports these names unchanged so
// external consumers see no surface drift).

export type TestServer = never;
export type TestServerConfig = never;
export type TestServerConnection = never;

export function makeTestServer(): never {
  throw new Error(
    "driver/test-server.makeTestServer: stub — implementer to port from testing/test-server.ts",
  );
}
