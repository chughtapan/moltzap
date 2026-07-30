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

/** Represents toxic profile values. */
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

/** Represents toxic tag values. */
export type ToxicTag = (typeof allToxicTags)[number];
