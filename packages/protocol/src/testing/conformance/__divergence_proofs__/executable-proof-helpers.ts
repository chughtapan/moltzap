import { Cause, Chunk, Effect, Option } from "effect";
import {
  PropertyAssertionFailure,
  PropertyDeferred,
  PropertyInvariantViolation,
  PropertyUnavailable,
  type PropertyFailure,
  type RegisteredProperty,
} from "../_shared/registry.js";

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
    throw new ProofExpectationError(
      `expected invariant failure, got ${failure._tag}: ${describeFailure(failure)}`,
    );
  }
  if (failure.name !== propertyName) {
    throw new ProofExpectationError(
      `expected ${propertyName}, got ${failure.name}`,
    );
  }
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
    throw new ProofExpectationError(
      `expected assertion failure, got ${failure._tag}: ${describeFailure(failure)}`,
    );
  }
  if (failure.name !== propertyName) {
    throw new ProofExpectationError(
      `expected ${propertyName}, got ${failure.name}`,
    );
  }
}

/**
 * Assert the registrar emits a typed `PropertyDeferred` whose `followUp`
 * mentions `expectedReasonSubstring`. Used by registrars whose property
 * body is a documented tombstone pending a future infrastructure landing
 * (e.g. cross-impl `dispatch/request` driver in TestServer, #529 row 13).
 *
 * The proof is meaningful: it confirms the registrar (a) is wired into
 * the suite, (b) emits a typed failure (not a silent pass, not an
 * untyped defect), (c) cites the expected follow-up. When the
 * infrastructure lands, registrar bodies become real assertions and
 * these proofs flip to `expectInvariant` / `expectAssertionFailure`
 * against a known-bad implementation, mirroring the existing pattern.
 */
export function expectDeferred(
  failure: PropertyFailure,
  propertyName: string,
  expectedReasonSubstring: string,
): void {
  if (!(failure instanceof PropertyDeferred)) {
    throw new ProofExpectationError(
      `expected deferred failure, got ${failure._tag}: ${describeFailure(failure)}`,
    );
  }
  if (failure.name !== propertyName) {
    throw new ProofExpectationError(
      `expected ${propertyName}, got ${failure.name}`,
    );
  }
  if (!failure.followUp.includes(expectedReasonSubstring)) {
    throw new ProofExpectationError(
      `expected followUp to include "${expectedReasonSubstring}", got "${failure.followUp}"`,
    );
  }
}
