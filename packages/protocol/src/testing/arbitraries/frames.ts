/**
 * Frame-level arbitraries.
 *
 * Tier A exercises all three frame schemas directly; Tier E2's fuzz
 * composes these with per-RPC params to produce inbound-frame arbitraries
 * the real server must absorb without crashing.
 */
import * as fc from "fast-check";
import {
  JSON_RPC_VERSION,
  RequestFrameSchema,
  ResponseFrameSchema,
  jsonRpcMethod,
  type RequestFrame,
  type ResponseFrame,
  type NotificationFrame,
} from "../../transport/wire.js";
import { notificationDefinitions } from "../../rpc-registry.js";
import type { MalformedFrameKind, AnyFrame } from "../codec.js";
import { arbitraryFromSchema } from "./from-typebox.js";

const FRAME_SEED_MAX = 2_147_483_647;

const malformedKinds = [
  "bit-flip",
  "truncated",
  "oversized",
  "invalid-utf8",
  "missing-required-field",
  "extra-property",
] as const satisfies readonly MalformedFrameKind[];

export function arbitraryRequestFrame(): fc.Arbitrary<RequestFrame> {
  return arbitraryFromSchema(RequestFrameSchema) as fc.Arbitrary<RequestFrame>;
}

export function arbitraryResponseFrame(): fc.Arbitrary<ResponseFrame> {
  return arbitraryFromSchema(
    ResponseFrameSchema,
  ) as fc.Arbitrary<ResponseFrame>;
}

export function arbitraryNotificationFrame(): fc.Arbitrary<NotificationFrame> {
  // Post-Phase-12 (#222) the typed inbound decoder rejects notifications
  // whose method is not in `notificationDefinitions`. Frames generated
  // here drive real-client conformance properties, so the method must be
  // a registered notification name and the params must validate against
  // that descriptor's schema.
  const definitionArb = fc.constantFrom(...notificationDefinitions);
  return definitionArb.chain((def) =>
    arbitraryFromSchema(def.paramsSchema).map(
      (params) =>
        ({
          jsonrpc: JSON_RPC_VERSION,
          method: jsonRpcMethod(def.name),
          params,
        }) as NotificationFrame,
    ),
  );
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
    arbitraryNotificationFrame().map((f) => f as AnyFrame),
  );
  return fc.record({
    base: baseArb,
    kind: fc.constantFrom(...malformedKinds),
    seed: fc.integer({ min: 1, max: FRAME_SEED_MAX }),
  });
}
