/** PGlite-based integration tests — no external Postgres needed. */

import type { TestProject } from "vitest/node";

/**
 * Provides the in-process integration-test database marker.
 * @param project Vitest project context.
 * @param project.provide Vitest value provider.
 * @returns A no-op teardown callback.
 */
export function setup({ provide }: TestProject) {
  // PGlite runs in-process — no container setup needed.
  // Signal to test-utils that we're using PGlite.
  provide("testPgHost", "pglite");
  provide("testPgPort", 0);

  return () => {
    // No container to tear down.
  };
}
