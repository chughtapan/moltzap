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
 * Every delivery-layer property one toxic is expected to re-exercise.
 * Keyed by the property's semantic name (matches the register-function
 * names in `conformance/delivery.ts`).
 */
export type DeliveryInvariantName =
  | "fan-out-cardinality"
  | "store-and-replay"
  | "payload-opacity"
  | "task-boundary-isolation";

/**
 * Selector: pick the delivery invariant a given toxic re-exercises.
 * Adversity module uses this to pair a toxic with the single delivery
 * property it must preserve under adversity.
 *
 * Historical grouping: spec #181 §5 labels these "Tier C"; the code
 * surface uses semantic names.
 *
 * | Toxic        | Exercises                      |
 * |--------------|--------------------------------|
 * | latency      | fan-out-cardinality under reorder |
 * | bandwidth    | fan-out-cardinality under throttle |
 * | slicer       | payload-opacity under partial-frame |
 * | reset_peer   | store-and-replay after reconnect |
 * | timeout      | fan-out-cardinality + eventual consistency |
 * | slow_close   | task-boundary-isolation survives slow close |
 */
export function deliveryInvariantFor(toxic: ToxicTag): DeliveryInvariantName {
  switch (toxic) {
    case "latency":
    case "bandwidth":
    case "timeout":
      return "fan-out-cardinality";
    case "reset_peer":
      return "store-and-replay";
    case "slicer":
      return "payload-opacity";
    case "slow_close":
      return "task-boundary-isolation";
    default: {
      const _exhaustive: never = toxic;
      throw new Error(
        `deliveryInvariantFor: unexpected toxic ${String(_exhaustive)}`,
      );
    }
  }
}
