/**
 * Tier B — RPC semantics against the reference model (B1–B5). Covers AC6.
 *
 * Each property drives both TestClient (against real server) and TestServer
 * (against real client) where applicable. Stateful fast-check: command
 * sequences thread `ReferenceState` and compare to server-observed state
 * after every step.
 */
import type { ConformanceRunContext } from "./runner.js";

/** B1 — real impl shape matches reference-model outcome. */
export function registerB1ModelEquivalence(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** B2 — authorized caller → typed success. */
export function registerB2AuthorityPositive(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** B3 — unauthorized caller → typed `AuthRequired` | `Forbidden`. */
export function registerB3AuthorityNegative(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** B4 — request-id uniqueness. */
export function registerB4RequestIdUniqueness(
  ctx: ConformanceRunContext,
): void {
  throw new Error("not implemented");
}

/** B5 — idempotent RPCs replay cleanly (`isIdempotent` oracle). */
export function registerB5Idempotence(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}
