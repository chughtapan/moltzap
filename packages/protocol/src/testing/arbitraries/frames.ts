/**
 * Frame-level arbitraries.
 *
 * Tier A exercises all three frame schemas directly; Tier E2's fuzz
 * composes these with per-RPC params to produce inbound-frame arbitraries
 * the real server must absorb without crashing.
 */
import * as fc from "fast-check";
import {
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
  type RequestFrame,
  type ResponseFrame,
  type EventFrame,
} from "../../schema/frames.js";
import type { MalformedFrameKind, AnyFrame } from "../codec.js";
import { arbitraryFromSchema } from "./from-typebox.js";

const malformedKinds = [
  "bit-flip",
  "truncated",
  "oversized",
  "invalid-utf8",
  "missing-required-field",
  "extra-property",
] as const satisfies readonly MalformedFrameKind[];

export function arbitraryRequestFrame(): fc.Arbitrary<RequestFrame> {
  return arbitraryFromSchema(RequestFrameSchema);
}

export function arbitraryResponseFrame(): fc.Arbitrary<ResponseFrame> {
  return arbitraryFromSchema(ResponseFrameSchema);
}

export function arbitraryEventFrame(): fc.Arbitrary<EventFrame> {
  return arbitraryFromSchema(EventFrameSchema);
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

export function arbitraryMalformedFrame(): fc.Arbitrary<ArbitraryMalformedFrame> {
  const baseArb: fc.Arbitrary<AnyFrame> = fc.oneof(
    arbitraryRequestFrame().map((f) => f as AnyFrame),
    arbitraryResponseFrame().map((f) => f as AnyFrame),
    arbitraryEventFrame().map((f) => f as AnyFrame),
  );
  return fc.record({
    base: baseArb,
    kind: fc.constantFrom(...malformedKinds),
    seed: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
  });
}
