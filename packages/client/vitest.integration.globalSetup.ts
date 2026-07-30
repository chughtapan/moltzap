/** PGlite-based integration tests — no external Postgres needed. */

import type { TestProject } from "vitest/node";

/**
 * Configure the in-process PGlite integration fixture.
 * @param root0 Vitest project context.
 * @param root0.provide Fixture-value publisher.
 * @returns The no-op fixture teardown callback.
 */
export function setup({ provide }: TestProject) {
  provide("testPgHost", "pglite");
  provide("testPgPort", 0);

  return () => {};
}
