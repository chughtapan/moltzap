/**
 * Conformance-suite shared helpers — small utilities used by multiple
 * property modules. Keep this file thin; promote utilities here only
 * when they would otherwise be duplicated verbatim.
 */
import { Effect, Either } from "effect";

export function requireRight<A, E, F>(
  value: Either.Either<A, E>,
  onLeft: (error: E) => F,
): Effect.Effect<A, F> {
  return Either.match(value, {
    onLeft: (error) => Effect.fail(onLeft(error)),
    onRight: (success) => Effect.succeed(success),
  });
}

export function leftOrNull<A, E>(value: Either.Either<A, E>): E | null {
  return Either.match(value, {
    onLeft: (error) => error,
    onRight: () => null,
  });
}

export function eitherTag<A, E extends { readonly _tag: string }>(
  value: Either.Either<A, E>,
): "Right" | E["_tag"] {
  return Either.match(value, {
    onLeft: (error) => error._tag,
    onRight: () => "Right",
  });
}
