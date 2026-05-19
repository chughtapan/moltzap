/* eslint-disable agent-code-guard/no-conditional-chaining -- composeServiceTeardown IS the resolution site for nullable scope+client inputs; the `closeXxxIfPresent` helpers each narrow their one nullable arg to a concrete `Effect`, so by the time `zipRight` runs every value is fully resolved. The rule fires on the parameter declarations (regarding them as "carriers"), but pushing the null-narrowing to every caller of `MoltZapService.close` would duplicate the conditional shape across the package. */
import { Effect, Exit, Scope } from "effect";

/**
 * Build the close-order teardown Effect for `MoltZapService.close`:
 * close the service-owned scope (which interrupts the
 * `subscribeAll → Stream.runForEach` fan-out fiber) BEFORE invoking the
 * ws-client's `close()`. Exposed as a top-level pure helper so the
 * ordering can be exercised by a regression test without spinning up
 * the full service. Codex r0 caught the original two-`runFork` race
 * here; the regression test in `service.test.ts` pins the structural
 * fix (P2-4 r1 cleanup).
 *
 * The chain is single-fork by construction (`Effect.zipRight`): the
 * ws-client `close()` does not begin until the scope finalizer chain
 * has completed.
 */
function closeScopeIfPresent(
  serviceScope: Scope.CloseableScope | null,
): Effect.Effect<void, never> {
  if (serviceScope === null) return Effect.void;
  return Scope.close(serviceScope, Exit.void);
}

function closeClientIfPresent(
  client: { readonly close: () => Effect.Effect<void, never> } | null,
): Effect.Effect<void, never> {
  if (client === null) return Effect.void;
  return client.close();
}

export function composeServiceTeardown(
  serviceScope: Scope.CloseableScope | null,
  client: { readonly close: () => Effect.Effect<void, never> } | null,
): Effect.Effect<void, never> {
  // Resolve each optional input to a concrete Effect via the dedicated
  // `closeXxxIfPresent` helpers, then sequence with `zipRight`. Single-fork
  // sequencing: ws-client `close()` does not begin until the scope
  // finalizer chain has completed.
  const closeScope = closeScopeIfPresent(serviceScope);
  const closeClient = closeClientIfPresent(client);
  return closeScope.pipe(Effect.zipRight(closeClient));
}
