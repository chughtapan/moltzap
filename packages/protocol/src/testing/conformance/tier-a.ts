/**
 * Tier A — Schema conformance (A1–A5). Covers AC5.
 *
 * Each `register*` function binds a Vitest `describe`/`it` block against
 * fast-check properties. Functions take the run context (real server,
 * seeds); implementations stay out of this stub.
 */
import type { ConformanceRunContext } from "./runner.js";

/** A1 — valid request ⇒ valid-shape response. */
export function registerA1Requests(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** A2 — valid event ⇒ accepted by real client. */
export function registerA2Events(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** A3 — parse(serialize(frame)) ≡ frame. */
export function registerA3RoundTrip(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** A4 — malformed frames produce typed error or drop, never crash. */
export function registerA4Malformed(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** A5 — every `RpcMethodName` exercised with at least one valid call. */
export function registerA5Coverage(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}
