import { Effect, Option } from "effect";
import { InvalidParamsError } from "./errors.js";

/** AJV validator shape (`Ajv.ValidateFunction`) without importing AJV. */
export type Validator<T> = (input: unknown) => input is T;

/**
 * Lift an AJV validator into an Effect. Succeeds with the narrowed `T`,
 * fails with `InvalidParamsError` — never defects. The `T` parameter must
 * match the AJV schema at the call site.
 */
export const validateParams = <T>(
  validator: Validator<T>,
  input: unknown,
): Effect.Effect<T, InvalidParamsError> =>
  Effect.try({
    try: () => Option.liftPredicate(input, validator),
    catch: invalidParamsError,
  }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(invalidParamsError()),
        onSome: Effect.succeed,
      }),
    ),
  );

function invalidParamsError() {
  return new InvalidParamsError({ message: "Invalid parameters" });
}
