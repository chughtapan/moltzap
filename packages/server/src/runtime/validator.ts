import { Effect } from "effect";
import { InvalidParamsError } from "./errors.js";

/** AJV validator shape (`Ajv.ValidateFunction`) without importing AJV. */
export type Validator<T> = (input: unknown) => input is T;

/**
 * Lift an AJV validator into an Effect. Succeeds with the narrowed `T`,
 * fails with `InvalidParamsError` — never defects. The `T` parameter must
 * match the AJV schema at the call site.
 */
export const validateParams = <T>(
  validator: (input: unknown) => boolean,
  input: unknown,
): Effect.Effect<T, InvalidParamsError> =>
  validator(input)
    ? Effect.succeed(input as T)
    : Effect.fail(new InvalidParamsError({ message: "Invalid parameters" }));
