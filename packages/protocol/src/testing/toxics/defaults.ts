/**
 * Per-toxic default parameters. These are the tuple every Tier D run
 * attaches unless a property overrides them.
 *
 * Rationale (see design doc §9 "Per-toxic default profiles"):
 *
 *   latency     — 100ms base + 50ms jitter: large enough to reorder
 *                 concurrent sends on a localhost loopback, small enough
 *                 that a 30s suite runs in CI time.
 *   bandwidth   — 64 KB/s: well below single-message throughput so
 *                 backpressure regimes (§5 D2) diverge observably.
 *   slicer      — 32-byte slices, 500µs delay: forces frame boundaries to
 *                 split inside a JSON payload.
 *   reset_peer  — 2000ms: long enough that a typical RPC commits before
 *                 the reset, short enough for the reconnect (D4) loop.
 *   timeout     — 5000ms: matches the default `defaultTimeoutMs` of
 *                 TestClient so the caller-surfaced error is the
 *                 documented timeout.
 *   slow_close  — 250ms: bounded below CI scheduler jitter; asserts the
 *                 reaper does not leak.
 */
import type { ToxicProfile } from "./profile.js";

export const defaultToxicProfile: {
  readonly latency: ToxicProfile & { readonly _tag: "latency" };
  readonly bandwidth: ToxicProfile & { readonly _tag: "bandwidth" };
  readonly slicer: ToxicProfile & { readonly _tag: "slicer" };
  readonly reset_peer: ToxicProfile & { readonly _tag: "reset_peer" };
  readonly timeout: ToxicProfile & { readonly _tag: "timeout" };
  readonly slow_close: ToxicProfile & { readonly _tag: "slow_close" };
} = {
  latency: { _tag: "latency", latencyMs: 100, jitterMs: 50 },
  bandwidth: { _tag: "bandwidth", rateKbps: 64 },
  slicer: { _tag: "slicer", averageSize: 32, delayUs: 500 },
  reset_peer: { _tag: "reset_peer", timeoutMs: 2000 },
  timeout: { _tag: "timeout", timeoutMs: 5000 },
  slow_close: { _tag: "slow_close", delayMs: 250 },
};
