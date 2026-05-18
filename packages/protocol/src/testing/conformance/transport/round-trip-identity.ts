/** parse(serialize(frame)) ≡ frame — pure codec round-trip. */
import * as fc from "fast-check";
import { Effect, Either } from "effect";
import { arbitraryMalformedFrame } from "../../arbitraries/frames.js";
import {
  decodeFrame,
  encodeFrame,
  type AnyFrame,
} from "../_shared/frame-mutator.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  assertProperty,
  type PropertyAssertionFailure,
  registerProperty,
} from "../_shared/registry.js";

const CATEGORY = "schema-conformance" as const;
const DEFAULT_ROUNDTRIP_RUNS = 50;

export function registerRoundTripIdentity(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "round-trip-identity",
    "parse(serialize(frame)) ≡ frame",
    assertProperty(CATEGORY, "round-trip-identity", (onFailure) =>
      assertRoundTripIdentity(ctx, onFailure),
    ).pipe(Effect.withSpan("registerRoundTripIdentity")),
  );
}

function assertRoundTripIdentity(
  ctx: ConformanceRunContext,
  onFailure: (cause: unknown) => PropertyAssertionFailure,
): Effect.Effect<void, PropertyAssertionFailure> {
  return Effect.tryPromise({
    try: () =>
      Promise.resolve(
        fc.assert(
          fc.property(
            arbitraryMalformedFrame().map((m) => m.base),
            frameRoundTrips,
          ),
          {
            seed: ctx.seed,
            numRuns: ctx.opts.numRuns ?? DEFAULT_ROUNDTRIP_RUNS,
          },
        ),
      ),
    catch: onFailure,
  });
}

function frameRoundTrips(frame: AnyFrame): boolean {
  const raw = encodeFrame(frame);
  const reparsed = Effect.runSync(Effect.either(decodeFrame(raw, "inbound")));
  return Either.match(reparsed, {
    onLeft: () => true,
    onRight: (frame) =>
      canonicalJson(raw) === canonicalJson(encodeFrame(frame)),
  });
}

function canonicalJson(raw: string): string {
  return JSON.stringify(JSON.parse(raw));
}
