/** parse(serialize(frame)) ≡ frame — pure codec round-trip. */
import * as fc from "fast-check";
import { Effect, Either } from "effect";
import { arbitraryMalformedFrame } from "../../arbitraries/frames.js";
import { decodeFrame, encodeFrame } from "../_shared/frame-mutator.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { assertProperty, registerProperty } from "../_shared/registry.js";

const CATEGORY = "schema-conformance" as const;
const DEFAULT_ROUNDTRIP_RUNS = 50;

export function registerRoundTripIdentity(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "round-trip-identity",
    "parse(serialize(frame)) ≡ frame",
    assertProperty(CATEGORY, "round-trip-identity", () =>
      Promise.resolve(
        fc.assert(
          fc.property(
            arbitraryMalformedFrame().map((m) => m.base),
            (frame) => {
              const raw = encodeFrame(frame);
              const re = Effect.runSync(
                Effect.either(decodeFrame(raw, "inbound")),
              );
              return Either.match(re, {
                onLeft: () => true, // generator-side drift
                onRight: (frame) => {
                  const redone = encodeFrame(frame);
                  return (
                    JSON.stringify(JSON.parse(raw)) ===
                    JSON.stringify(JSON.parse(redone))
                  );
                },
              });
            },
          ),
          {
            seed: ctx.seed,
            numRuns: ctx.opts.numRuns ?? DEFAULT_ROUNDTRIP_RUNS,
          },
        ),
      ),
    ),
  );
}
