/**
 * Client-side schema-conformance properties.
 *
 * Covers spec-amendment #200 §5:
 *   A2 — event-well-formedness (client-side new)
 *   A4 — malformed-frame-handling (client half of both-sides)
 *
 * Predicate-authoring discipline:
 *   - P1 (#195): every predicate names a server-realistic misbehaviour.
 *     Here it's "real client surfaces a malformed or dropped event."
 *   - P2 (#195): every property ships a divergence proof in
 *     `__divergence_proofs__/client-schema-conformance.proofs.ts`.
 *   - O7 (#200): every observation filters by property-authored
 *     `emissionTag` via `ClientHandshakeWindow.emitTaggedEvent` — auto-
 *     subscribe / hello / resume frames never satisfy a predicate.
 *   - O6 (#200): when spec names a typed error, assert exact match.
 *     A4 client half: `MalformedFrameError`
 *     (`packages/client/src/runtime/errors.ts`) is the documented type.
 *     Predicate accepts either "silently dropped + liveness probe
 *     surfaces" OR "typed MalformedFrameError fires"; never a generic
 *     error.
 */
import type { ClientConformanceRunContext } from "./runner.js";

/**
 * A2 client-side — TestServer emits an arbitrary valid `EventFrame`
 * with a property-authored `emissionTag`; real client's subscriber
 * surfaces an event whose payload schema-matches within deadline.
 *
 * Predicate: `observed.decoded` passes `Value.Check(EventFrameSchema)`
 * AND `observed.emissionTag === emittedTag`.
 *
 * Discriminates: a client that decodes payload with the wrong schema
 * (e.g. strips fields, coerces numeric strings) fails.
 */
export function registerEventWellFormednessClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}

/**
 * A4 client half — TestServer emits a bit-flipped / truncated /
 * oversized frame tagged with `emissionTag`; real client either (a)
 * drops silently OR (b) surfaces a typed `MalformedFrameError` on its
 * documented error channel. A subsequent tagged valid event still
 * surfaces (liveness proof, mirrors #187 round-5 guard).
 *
 * Predicate conjunction (all three must hold):
 *   - no process / fiber crash observable to the suite's Scope
 *   - reaction in {drop, typed MalformedFrameError} — generic
 *     `Error` or untyped disconnect fails
 *   - liveness: next tagged event surfaces within deadline
 */
export function registerMalformedFrameHandlingClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}
