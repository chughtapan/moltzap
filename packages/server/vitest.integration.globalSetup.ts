/** PGlite-based integration tests — no external Postgres needed. */

import type { GlobalSetupContext } from "vitest/node";

export default async function ({ provide }: GlobalSetupContext) {
  // PGlite runs in-process — no container setup needed.
  // Signal to test-utils that we're using PGlite.
  provide("testPgHost", "pglite");
  provide("testPgPort", 0);

  return async () => {
    // No container to tear down.
  };
}
