import { Cause, Chunk, Effect, Option } from "effect";
import {
  PropertyAssertionFailure,
  PropertyInvariantViolation,
  PropertyUnavailable,
  type PropertyFailure,
  type RegisteredProperty,
} from "../registry.js";

class ProofExpectationError extends Error {
  override readonly name = "ProofExpectationError";
}

function describeFailure(failure: PropertyFailure): string {
  if (failure instanceof PropertyUnavailable) return failure.reason;
  if (failure instanceof PropertyInvariantViolation) return failure.reason;
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
  });
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
