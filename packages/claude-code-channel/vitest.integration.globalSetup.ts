/**
 * Global setup for integration tests.
 *
 * Architect stage: signature only. implement-staff wires up the real
 * `@moltzap/server` subprocess spawn (per sbd#182 spike pattern: PGlite +
 * `npx @moltzap/server`) and a peer agent registration, providing
 * coordinates to the echo integration test.
 */

import type { GlobalSetupContext } from "vitest/node";

export default async function ({ provide: _provide }: GlobalSetupContext) {
  throw new Error("not implemented");
}
