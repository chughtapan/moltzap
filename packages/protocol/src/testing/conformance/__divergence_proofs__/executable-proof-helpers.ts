import { Cause, Chunk, Effect, Either, Option } from "effect";
import { expect } from "vitest";
import {
  PropertyAssertionFailure,
  PropertyDeferred,
  PropertyInvariantViolation,
  PropertyUnavailable,
  type PropertyFailure,
  type RegisteredProperty,
} from "../_shared/registry.js";

// ── Mux envelope helpers ─────────────────────────────────────────────────────
//
// The live transport multiplexes the socket with a `{ ch, f }` envelope
// (`native-mux.ts`): the driver wraps every outbound request and unwraps every
// inbound frame. The known-bad servers mirror that framing so their raw
// JSON-RPC handlers stay envelope-agnostic — unwrap each inbound chunk before
// decode, wrap each reply on the `c2s` channel where its request arrived.

/**
 * Strip a WELL-FORMED `{ ch, f }` mux envelope to its inner frame. An envelope
 * is only unwrapped when `ch` is a valid channel AND `f` is a string; a bare
 * frame (no envelope) passes through unchanged. A malformed envelope (e.g.
 * missing `ch`) is NOT silently accepted as the inner frame, so the harness
 * still rejects garbage framing.
 */
export function muxUnwrap(raw: string): string {
  const parsed = Either.getOrNull(Either.try(() => JSON.parse(raw) as unknown));
  if (typeof parsed !== "object" || parsed === null) return raw;
  const env = parsed as { readonly ch?: unknown; readonly f?: unknown };
  const isEnvelope =
    (env.ch === "c2s" || env.ch === "s2c") && typeof env.f === "string";
  return isEnvelope ? (env.f as string) : raw;
}

/** Wrap a reply frame on the c2s channel — responses ride back where requests arrive. */
export const muxWrapC2s = (frame: string): string =>
  JSON.stringify({ ch: "c2s", f: frame });

class ProofExpectationError extends Error {
  override readonly name = "ProofExpectationError";
}

function describeFailure(failure: PropertyFailure): string {
  if (failure instanceof PropertyUnavailable) return failure.reason;
  if (failure instanceof PropertyInvariantViolation) return failure.reason;
  if (failure instanceof PropertyDeferred) return failure.followUp;
  return String(failure.cause);
}

export function runExpectingFailure(
  property: RegisteredProperty,
): Effect.Effect<PropertyFailure> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(property.run);
    if (exit._tag === "Success") {
      return yield* Effect.die(
        new Error(`${property.category}/${property.name} unexpectedly passed`),
      );
    }
    const failures = Cause.failures(exit.cause);
    const failure = Option.getOrNull(Chunk.head(failures));
    if (failure === null) {
      return yield* Effect.die(
        new Error(`expected typed failure, got ${exit.cause.toString()}`),
      );
    }
    return failure;
  }).pipe(Effect.withSpan("runExpectingFailure"));
}

export function expectInvariant(
  failure: PropertyFailure,
  propertyName: string,
): void {
  if (!(failure instanceof PropertyInvariantViolation)) {
    expect(failure).toBeInstanceOf(PropertyInvariantViolation);
    throw new ProofExpectationError(
      `expected invariant failure, got ${failure._tag}: ${describeFailure(failure)}`,
    );
  }
  expect(failure.name, failure.reason).toBe(propertyName);
}

/**
 * Pin an invariant failure's `reason` to a specific arm. Used when the
 * proof needs to prove the property caught a specific divergence (not
 * any earlier fixture failure that happens to surface the same tag).
 */
export function expectViolationReasonIncludes(
  failure: PropertyFailure,
  expected: string,
): void {
  if (!(failure instanceof PropertyInvariantViolation)) {
    throw new ProofExpectationError(
      `expected invariant failure, got ${failure._tag}: ${describeFailure(failure)}`,
    );
  }
  if (!failure.reason.includes(expected)) {
    throw new ProofExpectationError(
      `expected reason to include "${expected}", got "${failure.reason}"`,
    );
  }
}

export function expectAssertionFailure(
  failure: PropertyFailure,
  propertyName: string,
): void {
  if (!(failure instanceof PropertyAssertionFailure)) {
    expect(failure).toBeInstanceOf(PropertyAssertionFailure);
    throw new ProofExpectationError(
      `expected assertion failure, got ${failure._tag}: ${describeFailure(failure)}`,
    );
  }
  expect(failure.name).toBe(propertyName);
}

/**
 * Assert the registrar emits a typed `PropertyDeferred` whose `followUp`
 * mentions `expectedReasonSubstring`. Used by registrars whose property
 * body is a documented tombstone pending infrastructure not yet present
 * (e.g. a cross-impl `dispatch/request` driver in TestServer).
 *
 * The proof is meaningful: it confirms the registrar (a) is wired into
 * the suite, (b) emits a typed failure (not a silent pass, not an
 * untyped defect), (c) cites the expected follow-up.
 */
export function expectDeferred(
  failure: PropertyFailure,
  propertyName: string,
  expectedReasonSubstring: string,
): void {
  if (!(failure instanceof PropertyDeferred)) {
    expect(failure).toBeInstanceOf(PropertyDeferred);
    throw new ProofExpectationError(
      `expected deferred failure, got ${failure._tag}: ${describeFailure(failure)}`,
    );
  }
  expect(failure.name).toBe(propertyName);
  expect(failure.followUp).toContain(expectedReasonSubstring);
}
