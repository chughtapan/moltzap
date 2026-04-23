/**
 * Frame-level arbitraries.
 *
 * Tier A exercises all three frame schemas directly; Tier E2's fuzz
 * composes these with per-RPC params to produce inbound-frame arbitraries
 * the real server must absorb without crashing.
 */
import type { Arbitrary } from "fast-check";
import type {
  RequestFrame,
  ResponseFrame,
  EventFrame,
} from "../../schema/frames.js";
import type { MalformedFrameKind, AnyFrame } from "../codec.js";

export function arbitraryRequestFrame(): Arbitrary<RequestFrame> {
  throw new Error("not implemented");
}

export function arbitraryResponseFrame(): Arbitrary<ResponseFrame> {
  throw new Error("not implemented");
}

export function arbitraryEventFrame(): Arbitrary<EventFrame> {
  throw new Error("not implemented");
}

/**
 * Arbitrary of a `(baseFrame, MalformedFrameKind, seed)` tuple so Tier A /
 * D can replay a specific mutation on shrink.
 */
export interface ArbitraryMalformedFrame {
  readonly base: AnyFrame;
  readonly kind: MalformedFrameKind;
  readonly seed: number;
}

export function arbitraryMalformedFrame(): Arbitrary<ArbitraryMalformedFrame> {
  throw new Error("not implemented");
}
