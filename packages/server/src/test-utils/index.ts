/** @file Shared server-core test utility exports. */

// safer-arch-ignore no-public-vendor-type-leak: TRIAGE: the test harness exposes live Kysely and OpenTelemetry handles used by integration tooling; define server-owned test ports before removing them.
// safer-arch-ignore no-public-test-helper-leak: ./test-utils is the package's explicitly allowed test-only subpath, and this index is its curated facade.

export {
  getBaseUrl,
  getWsUrl,
  resetCoreTestDb,
  startCoreTestServer,
  stopCoreTestServer,
} from "./server.js";
export type { CoreTestRuntimeServerHandle, CoreTestServer } from "./server.js";
export { createTestAgent } from "./helpers.js";
