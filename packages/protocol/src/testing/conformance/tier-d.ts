/**
 * Tier D — Adversity resilience under Toxiproxy (D1–D6). Covers AC8.
 *
 * Each D property picks a Tier C invariant via `tierCInvariantFor` and
 * re-runs it with the named toxic attached via the `Proxy` scope. Failure
 * surfaces include both the fast-check seed and the toxic profile so AC10
 * replay is byte-for-byte.
 */
import type { ConformanceRunContext } from "./runner.js";

/** D1 — latency: C1/C2 still hold; eventual consistency after removal. */
export function registerD1Latency(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** D2 — bandwidth / backpressure contract. */
export function registerD2Backpressure(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** D3 — slicer: no partial frame reaches a handler. */
export function registerD3Slicer(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** D4 — reset peer: auto-reconnect restores session. */
export function registerD4ResetPeer(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** D5 — timeout: caller-surfaced error is documented timeout type. */
export function registerD5Timeout(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}

/** D6 — slow close: connection reaps; no leak. */
export function registerD6SlowClose(ctx: ConformanceRunContext): void {
  throw new Error("not implemented");
}
