/** PGlite-based integration tests — no external Postgres needed. */

import type { GlobalSetupContext } from "vitest/node";

export default function ({ provide }: GlobalSetupContext) {
  provide("testPgHost", "pglite");
  provide("testPgPort", 0);

  return () => {};
}
