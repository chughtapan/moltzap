/**
 * Toxic profile DSL.
 *
 * Per D2 and Invariant I4, adversity is a parameter selected at suite
 * invocation, not hardcoded case-by-case. A `ToxicProfile` is a named
 * preset (one of the six toxics) plus its parameters; the Tier D runner
 * picks the matching Tier C invariant and re-runs it with the toxic
 * attached.
 *
 * Exhaustiveness: the `_tag` union covers every toxic named in §5 Tier D
 * (D1–D6) so the implementer cannot forget a branch in the client dispatch.
 */

export type ToxicProfile =
  | {
      readonly _tag: "latency";
      /** Added latency in milliseconds, per-packet. */
      readonly latencyMs: number;
      /** Random jitter in ms, uniform [0, jitterMs). */
      readonly jitterMs: number;
    }
  | {
      readonly _tag: "bandwidth";
      /** Throttled rate in kilobytes/sec. */
      readonly rateKbps: number;
    }
  | {
      readonly _tag: "slicer";
      /** Bytes per slice. Small values force partial-frame handling. */
      readonly averageSize: number;
      /** Delay between slices in microseconds. */
      readonly delayUs: number;
    }
  | {
      readonly _tag: "reset_peer";
      /** Timeout in ms before the toxic forcibly resets the connection. */
      readonly timeoutMs: number;
    }
  | {
      readonly _tag: "timeout";
      /** Stops forwarding after `timeoutMs`, simulating a black-hole hop. */
      readonly timeoutMs: number;
    }
  | {
      readonly _tag: "slow_close";
      /** Delay close-frame delivery by `delayMs`. */
      readonly delayMs: number;
    };

/** All six toxic tags, enumerated for coverage assertions in Tier D. */
export const allToxicTags = [
  "latency",
  "bandwidth",
  "slicer",
  "reset_peer",
  "timeout",
  "slow_close",
] as const;

export type ToxicTag = (typeof allToxicTags)[number];

/**
 * Selector: pick the Tier C invariant to re-run for a given toxic. Returned
 * names are the canonical Tier C property ids (`"C1"` | `"C2"` | …).
 * Per D2, every toxic maps to exactly one Tier C invariant.
 */
/**
 * Per spec #181 §5 D1–D6: every toxic maps to one Tier C invariant.
 *
 * | Toxic        | Exercises   |
 * |--------------|-------------|
 * | latency      | C1 (fan-out cardinality under reorder) |
 * | bandwidth    | C1 (fan-out still lands under throttle) |
 * | slicer       | C3 (payload opacity under partial-frame) |
 * | reset_peer   | C2 (store-and-replay after reconnect) |
 * | timeout      | C1 (fan-out + eventual consistency) |
 * | slow_close   | C4 (task-isolation survives slow close) |
 */
export function tierCInvariantFor(toxic: ToxicTag): "C1" | "C2" | "C3" | "C4" {
  switch (toxic) {
    case "latency":
    case "bandwidth":
    case "timeout":
      return "C1";
    case "reset_peer":
      return "C2";
    case "slicer":
      return "C3";
    case "slow_close":
      return "C4";
    default: {
      const _exhaustive: never = toxic;
      throw new Error(
        `tierCInvariantFor: unexpected toxic ${String(_exhaustive)}`,
      );
    }
  }
}
