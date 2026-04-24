/**
 * Client-side boundary properties.
 *
 * Covers spec-amendment #200 §5:
 *   E2 — schema-exhaustive-fuzz (client half of both-sides)
 *
 * E1 (webhook-graceful-shutdown) is N/A on the client side per spec —
 * no client-observable surface.
 */
import type { ClientConformanceRunContext } from "./runner.js";

/**
 * E2 client half — TestServer emits arbitrary `EventFrame`s across
 * every event type (TypeBox-derived arbitraries under
 * `arbitraries/frames.ts`) to a real client subscribed only to
 * task A. Properties interleave with periodic liveness probes and
 * a task-boundary assertion.
 *
 * Predicate (all three must hold — spec #200 §5 E2 revision):
 *   1. No crash — the real client's process / fiber remains alive
 *      through the fuzz burst (`RealClientHandle.ready` stays
 *      resolved; no spurious `closeSignal`).
 *   2. Liveness probe — an A2-shape valid event with a fresh
 *      `emissionTag` emitted post-fuzz is surfaced within deadline
 *      (reuses `registerEventWellFormednessClient`'s predicate).
 *   3. Task-boundary cleanliness — a C4-shape assertion holds
 *      post-fuzz: the task-A subscriber observes zero tagged
 *      task-B events emitted during or after the fuzz burst.
 *
 * Handshake-noise guard (O7) applies to both liveness + task-B
 * observations: every check filters by the post-fuzz `emissionTag`.
 */
export function registerSchemaExhaustiveFuzzClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}
