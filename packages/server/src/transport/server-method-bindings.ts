/**
 * @file The boot-time fail-closed wiring error for the native WS engine.
 */

/**
 * Impossible-state defect the server boot raises when the engine's gating
 * partition is violated — an authenticated method missing its `*AuthMw`, or the
 * built WS-subset member count drifting from the catalog. Either is a wiring bug
 * that must fail loudly at boot, never a silent permissive default
 * (`server.ts → validateEngineGating`).
 */
export class PrincipalKindRegistryError extends Error {
  override readonly name = "PrincipalKindRegistryError";
}
