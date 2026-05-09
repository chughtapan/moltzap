/**
 * Test client — wire harness that acts AS a JSON-RPC client to drive a
 * real server under test.
 *
 * Phase 1B re-architect (arch-1b-r2): preserves the pre-reorg
 * `testing/test-client.ts` (~860 LOC) as its own file under the new
 * `conformance/_shared/driver/` sub-folder. The file's role (test-time
 * wire driver, not an entity being tested) is documented at the
 * `driver/` package boundary; the file name stays `test-client.ts`
 * because that is what the file is.
 *
 * The pair `driver/test-client.ts` + `driver/test-server.ts` are siblings
 * by design — both are wire harnesses, both share the `CapturedFrame`
 * journal type and the `TestingError` channel, both compose under
 * `Effect.scoped` + `Effect.acquireRelease`. They live together in
 * `driver/` so the relationship is obvious; they remain separate files
 * so each role stays read-as-one-file.
 *
 * Architect stub — implementer ports the existing module body verbatim
 * and rewrites relative imports to the new `conformance/_shared/`
 * neighbours (e.g. `../../captures.js` → `../captures.js`,
 * `../../codec.js` → `../frame-mutator.js`,
 * `../../errors.js` → `../errors.js`).
 */

// Public exports (preserved verbatim from the pre-reorg `testing/test-client.ts`;
// the barrel at `testing/index.ts` re-exports these names unchanged so
// external consumers see no surface drift).

export type CloseableTestClient = never;
export type TestClient = never;
export type TestClientConfig = never;

export function makeCloseableTestClient(): never {
  throw new Error(
    "driver/test-client.makeCloseableTestClient: stub — implementer to port from testing/test-client.ts",
  );
}

export function makeTestClient(): never {
  throw new Error(
    "driver/test-client.makeTestClient: stub — implementer to port from testing/test-client.ts",
  );
}
