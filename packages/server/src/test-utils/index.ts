/** @file Shared server-core test utility exports. */

// safer-arch-ignore no-public-test-helper-leak: ./test-utils is the package's explicitly allowed test-only subpath, and this index is its curated facade.

import { Effect } from "effect";
import { startCoreTestServerEffect } from "./server.js";
import type {
  CoreTestServerPort,
  StartCoreTestServerOptions,
} from "./ports.js";

/** Re-exports the public API from `./server.js`. */
export {
  getBaseUrl,
  getWsUrl,
  resetCoreTestDb,
  stopCoreTestServer,
} from "./server.js";
/** Re-exports the public API from `./helpers.js`. */
export { createTestAgent } from "./helpers.js";
/** Re-exports the public API from `./ports.js`. */
export type {
  CoreTestDatabasePort,
  CoreTestReadyOutcome,
  CoreTestRuntimeServerHandle,
  CoreTestServerPort,
  CoreTestSpan,
  CoreTestSpanExporterPort,
  StartCoreTestServerOptions,
} from "./ports.js";

/** Canonical published handle for a running core test server. */
export type CoreTestServer = CoreTestServerPort;

/**
 * Start a test server and expose its package-owned integration ports.
 * @param opts Test server configuration.
 * @returns A promise for the running server's integration ports.
 */
export function startCoreTestServer(opts: StartCoreTestServerOptions = {}) {
  return Effect.runPromise(
    startCoreTestServerEffect(opts).pipe(
      Effect.map((server) => server.testPort),
    ),
  );
}
