import { Cause, Chunk, Effect, Option } from "effect";
import {
  PropertyAssertionFailure,
  PropertyInvariantViolation,
  type PropertyFailure,
  type RegisteredProperty,
} from "../registry.js";

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
    throw new Error(`expected invariant failure, got ${failure._tag}`);
  }
  if (failure.name !== propertyName) {
    throw new Error(`expected ${propertyName}, got ${failure.name}`);
  }
}

export function expectAssertionFailure(
  failure: PropertyFailure,
  propertyName: string,
): void {
  if (!(failure instanceof PropertyAssertionFailure)) {
    throw new Error(`expected assertion failure, got ${failure._tag}`);
  }
  if (failure.name !== propertyName) {
    throw new Error(`expected ${propertyName}, got ${failure.name}`);
  }
}
